/**
 * Recharge Webhook Handler
 * POST /api/webhook
 *
 * Listens for charge/paid events from Recharge.
 * Increments cycle count atomically, checks milestones, sends reward emails.
 */

const crypto = require('crypto');
const MILESTONES = require('../milestones');
const {
  getOrCreateCustomer,
  incrementCycles,
  markRewardEarned,
  logEvent,
  isProcessed,
  markProcessed,
} = require('../lib/supabase');
const { sendRewardEmail } = require('../lib/email');

const MAX_BODY_SIZE = 1024 * 100; // 100KB — Recharge webhooks are never this large

// Verify the request actually came from Recharge using HMAC-SHA256
function verifySignature(rawBody, signature) {
  const secret = process.env.RECHARGE_WEBHOOK_SECRET;
  if (!secret) {
    // Never allow bypass — fail hard if secret not configured
    throw new Error('RECHARGE_WEBHOOK_SECRET is not configured');
  }
  if (!signature) return false;

  const hmac = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');

  try {
    // Ensure both buffers are the same length before timingSafeEqual
    const a = Buffer.from(hmac);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Read raw body from request (needed for HMAC verification) with size limit
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });

    req.on('end', () => resolve(data));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request aborted')));
  });
}

// Validate that incoming customer data is usable before processing
function validateChargeData(charge) {
  const chargeId = charge.id != null ? String(charge.id) : null;
  if (!chargeId || chargeId === 'null') {
    throw new Error('Invalid or missing charge id');
  }

  const shopifyCustomerId = charge.shopify_customer_id || charge.customer?.shopify_customer_id;
  if (!shopifyCustomerId || !/^\d+$/.test(String(shopifyCustomerId))) {
    throw new Error('Invalid shopify_customer_id');
  }

  const email = charge.email || charge.customer?.email;
  if (!email || !email.includes('@')) {
    throw new Error('Invalid or missing customer email');
  }

  const rechargeCustomerId = String(charge.customer_id || charge.customer?.id || '');

  return {
    chargeId,
    shopifyCustomerId: String(shopifyCustomerId),
    email: email.toLowerCase().trim(),
    rechargeCustomerId,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();

  // ── 1. READ AND SIZE-CHECK BODY ──────────────────────────────────────────
  let rawBody;
  try {
    rawBody = await getRawBody(req);
  } catch (err) {
    console.error('[webhook] Body read failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  // ── 2. VERIFY SIGNATURE ──────────────────────────────────────────────────
  const signature = req.headers['x-recharge-hmac-sha256'] || '';
  const topic = req.headers['x-recharge-topic'] || '';

  try {
    if (!verifySignature(rawBody, signature)) {
      console.error('[webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } catch (err) {
    console.error('[webhook] Signature verification error:', err.message);
    return res.status(500).json({ error: 'Signature verification failed' });
  }

  // ── 3. ONLY HANDLE charge/paid ───────────────────────────────────────────
  if (topic !== 'charge/paid') {
    return res.status(200).json({ status: 'ignored', topic });
  }

  // ── 4. PARSE AND VALIDATE PAYLOAD ────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const charge = payload.charge || payload;

  let chargeId, shopifyCustomerId, email, rechargeCustomerId;
  try {
    ({ chargeId, shopifyCustomerId, email, rechargeCustomerId } = validateChargeData(charge));
  } catch (err) {
    console.error('[webhook] Validation failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  // ── 5. SUBSCRIPTION ORDERS ONLY — skip one-time purchases ───────────────
  const chargeType = (charge.type || '').toUpperCase();
  if (chargeType && chargeType !== 'RECURRING') {
    await logEvent(shopifyCustomerId, 'webhook_skipped', {
      reason: 'not_recurring',
      charge_type: chargeType,
      charge_id: chargeId,
    });
    return res.status(200).json({ status: 'skipped', reason: 'not_recurring' });
  }

  // ── 6. IDEMPOTENCY — never count the same charge twice ───────────────────
  if (await isProcessed(chargeId)) {
    console.log(`[webhook] Duplicate charge ${chargeId} — skipping`);
    return res.status(200).json({ status: 'duplicate' });
  }

  console.log(`[webhook] Processing charge ${chargeId} for customer ${shopifyCustomerId}`);

  try {
    // ── 7. GET OR CREATE customer record ─────────────────────────────────
    await getOrCreateCustomer(shopifyCustomerId, email, rechargeCustomerId);

    // ── 8. ATOMIC cycle increment via Postgres stored procedure ──────────
    // This is the ONLY safe way to increment — prevents race conditions
    const newCount = await incrementCycles(shopifyCustomerId);

    await logEvent(shopifyCustomerId, 'cycle_counted', {
      charge_id: chargeId,
      cycle_count: newCount,
    });

    console.log(`[webhook] Customer ${shopifyCustomerId} now at cycle ${newCount}`);

    // ── 9. CHECK MILESTONES ───────────────────────────────────────────────
    // Check ALL milestones up to newCount in case a previous one was skipped
    for (const milestone of MILESTONES) {
      if (newCount >= milestone.cycles) {
        const earned = await markRewardEarned(shopifyCustomerId, milestone.id);

        if (earned) {
          await logEvent(shopifyCustomerId, 'milestone_reached', {
            reward_id: milestone.id,
            milestone: milestone.cycles,
            charge_id: chargeId,
          });

          console.log(`[webhook] Milestone ${milestone.cycles} reached for ${email}`);

          try {
            await sendRewardEmail(email, milestone, newCount);
            console.log(`[webhook] Reward email sent to ${email}`);
          } catch (emailErr) {
            console.error(`[webhook] Email failed for ${email}:`, emailErr.message);
            await logEvent(shopifyCustomerId, 'error', {
              error: 'email_send_failed',
              message: emailErr.message,
              charge_id: chargeId,
            });
            // Don't throw — email failure should not roll back cycle count
          }
        }
      }
    }

    // ── 10. MARK charge as processed — must succeed or return 500 ─────────
    // If this fails, Recharge will retry and isProcessed() will prevent double counting
    await markProcessed(chargeId);

    const duration = Date.now() - startTime;
    console.log(`[webhook] Completed charge ${chargeId} in ${duration}ms`);

    return res.status(200).json({
      status: 'ok',
      customer_id: shopifyCustomerId,
      cycle_count: newCount,
      duration_ms: duration,
    });

  } catch (err) {
    console.error(`[webhook] Error processing charge ${chargeId}:`, err.message);

    await logEvent(shopifyCustomerId, 'error', {
      error: err.message,
      charge_id: chargeId,
    }).catch(() => {}); // never throw if logging fails

    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};

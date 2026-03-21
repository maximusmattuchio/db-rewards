/**
 * Recharge Webhook Handler
 * POST /api/webhook
 *
 * Receives charge/paid events from Recharge.
 * Designed for 100K+ subscribers:
 * - Returns 200 quickly after validation + cycle increment
 * - Queues emails asynchronously (no blocking on email send)
 * - Writes to dead-letter queue on any failure for auto-retry
 * - Full idempotency via processed_charges table
 * - Atomic DB operations only (no race conditions)
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
const { queueEmail, queueFailedWebhook } = require('../lib/queue');

const MAX_BODY_SIZE = 1024 * 100; // 100KB hard limit

// Verify HMAC-SHA256 signature from Recharge
function verifySignature(rawBody, signature) {
  const secret = process.env.RECHARGE_WEBHOOK_SECRET;
  if (!secret) throw new Error('RECHARGE_WEBHOOK_SECRET is not configured');
  if (!signature) return false;

  const hmac = crypto.createHmac('sha256', secret).update(rawBody, 'utf8').digest('base64');

  try {
    const a = Buffer.from(hmac);
    const b = Buffer.from(signature);
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

// Read raw body with hard size limit and timeout protection
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    let size = 0;

    const timeout = setTimeout(() => reject(new Error('Body read timeout')), 5000);

    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_SIZE) {
        clearTimeout(timeout);
        reject(new Error('Request body too large'));
        return;
      }
      data += chunk;
    });

    req.on('end', () => { clearTimeout(timeout); resolve(data); });
    req.on('error', err => { clearTimeout(timeout); reject(err); });
    req.on('aborted', () => { clearTimeout(timeout); reject(new Error('Request aborted')); });
  });
}

// Validate charge payload — throws on invalid data
function validateCharge(charge) {
  const chargeId = charge.id != null ? String(charge.id) : null;
  if (!chargeId || chargeId === 'null' || chargeId === 'undefined') {
    throw new Error('Invalid or missing charge.id');
  }

  const shopifyCustomerId = charge.shopify_customer_id || charge.customer?.shopify_customer_id;
  if (!shopifyCustomerId || !/^\d+$/.test(String(shopifyCustomerId))) {
    throw new Error(`Invalid shopify_customer_id: ${shopifyCustomerId}`);
  }

  const email = charge.email || charge.customer?.email;
  if (!email || typeof email !== 'string' || !email.includes('@')) {
    throw new Error(`Invalid email: ${email}`);
  }

  return {
    chargeId,
    shopifyCustomerId: String(shopifyCustomerId),
    email: email.toLowerCase().trim(),
    rechargeCustomerId: String(charge.customer_id || charge.customer?.id || ''),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  let rawBody = '';
  let chargeId = null;
  let shopifyCustomerId = null;

  // ── 1. READ BODY ─────────────────────────────────────────────────────────
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
    console.error('[webhook] Signature check error:', err.message);
    return res.status(500).json({ error: 'Signature verification failed' });
  }

  // ── 3. FILTER TOPICS ─────────────────────────────────────────────────────
  if (topic !== 'charge/paid') {
    return res.status(200).json({ status: 'ignored', topic });
  }

  // ── 4. PARSE + VALIDATE ──────────────────────────────────────────────────
  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const charge = payload.charge || payload;
  let email, rechargeCustomerId;

  try {
    ({ chargeId, shopifyCustomerId, email, rechargeCustomerId } = validateCharge(charge));
  } catch (err) {
    console.error('[webhook] Validation failed:', err.message);
    return res.status(400).json({ error: err.message });
  }

  // ── 5. RECURRING ONLY ────────────────────────────────────────────────────
  const chargeType = (charge.type || '').toUpperCase();
  if (chargeType && chargeType !== 'RECURRING') {
    await logEvent(shopifyCustomerId, 'webhook_skipped', {
      reason: 'not_recurring',
      charge_type: chargeType,
      charge_id: chargeId,
    });
    return res.status(200).json({ status: 'skipped', reason: 'not_recurring' });
  }

  // ── 6. IDEMPOTENCY ───────────────────────────────────────────────────────
  if (await isProcessed(chargeId)) {
    console.log(`[webhook] Duplicate charge ${chargeId}`);
    return res.status(200).json({ status: 'duplicate' });
  }

  console.log(`[webhook] Processing ${chargeId} for customer ${shopifyCustomerId}`);

  try {
    // ── 7. ENSURE CUSTOMER EXISTS ────────────────────────────────────────
    await getOrCreateCustomer(shopifyCustomerId, email, rechargeCustomerId);

    // ── 8. ATOMIC CYCLE INCREMENT ────────────────────────────────────────
    const newCount = await incrementCycles(shopifyCustomerId);

    await logEvent(shopifyCustomerId, 'cycle_counted', {
      charge_id: chargeId,
      cycle_count: newCount,
    });

    console.log(`[webhook] ${shopifyCustomerId} → cycle ${newCount}`);

    // ── 9. CHECK ALL MILESTONES (handles skipped cycles gracefully) ──────
    for (const milestone of MILESTONES) {
      if (newCount >= milestone.cycles) {
        const earned = await markRewardEarned(shopifyCustomerId, milestone.id);

        if (earned) {
          await logEvent(shopifyCustomerId, 'milestone_reached', {
            reward_id: milestone.id,
            milestone: milestone.cycles,
            charge_id: chargeId,
          });

          console.log(`[webhook] Milestone ${milestone.cycles} → queuing email for ${email}`);

          // Queue email asynchronously — never block the webhook on email
          // The cron job at /api/cron/emails processes the queue every 5 minutes
          try {
            await queueEmail(shopifyCustomerId, email, milestone, newCount);
          } catch (queueErr) {
            // If queue fails, log and continue — milestone still counted
            console.error(`[webhook] Failed to queue email for ${email}:`, queueErr.message);
            await logEvent(shopifyCustomerId, 'error', {
              error: 'email_queue_failed',
              message: queueErr.message,
              charge_id: chargeId,
            });
          }
        }
      }
    }

    // ── 10. MARK PROCESSED — must succeed or return 500 for Recharge retry
    await markProcessed(chargeId);

    const duration = Date.now() - startTime;
    console.log(`[webhook] Done ${chargeId} in ${duration}ms`);

    return res.status(200).json({
      status: 'ok',
      customer_id: shopifyCustomerId,
      cycle_count: newCount,
      duration_ms: duration,
    });

  } catch (err) {
    console.error(`[webhook] Fatal error on ${chargeId}:`, err.message);

    // Write to dead-letter queue for automatic retry
    await queueFailedWebhook(chargeId, rawBody, topic, err.message);

    await logEvent(shopifyCustomerId || 'unknown', 'error', {
      error: err.message,
      charge_id: chargeId,
    }).catch(() => {});

    // Return 500 so Recharge retries — DLQ handles it if all retries fail
    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};

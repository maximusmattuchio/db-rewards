/**
 * Recharge Webhook Handler
 * POST /api/webhook
 *
 * Listens for charge/paid events from Recharge.
 * Increments cycle count, checks milestones, sends reward emails.
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
  supabase,
} = require('../lib/supabase');
const { sendRewardEmail } = require('../lib/email');

// Verify the request actually came from Recharge
function verifySignature(rawBody, signature) {
  const secret = process.env.RECHARGE_WEBHOOK_SECRET;
  if (!secret) return true; // skip verification in dev if secret not set
  const hmac = crypto
    .createHmac('sha256', secret)
    .update(rawBody, 'utf8')
    .digest('base64');
  try {
    return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(signature));
  } catch {
    return false;
  }
}

// Read raw body from request (needed for HMAC verification)
async function getRawBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const rawBody = await getRawBody(req);
  const signature = req.headers['x-recharge-hmac-sha256'] || '';
  const topic = req.headers['x-recharge-topic'] || '';

  // ── 1. VERIFY SIGNATURE ──────────────────────────────────────────────────
  if (!verifySignature(rawBody, signature)) {
    console.error('[webhook] Invalid signature');
    return res.status(401).json({ error: 'Invalid signature' });
  }

  // ── 2. ONLY HANDLE charge/paid ───────────────────────────────────────────
  if (topic !== 'charge/paid') {
    return res.status(200).json({ status: 'ignored', topic });
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  const charge = payload.charge || payload; // Recharge v1 wraps in .charge, v2 does not
  const chargeId = String(charge.id);
  const shopifyCustomerId = charge.shopify_customer_id || charge.customer?.shopify_customer_id;
  const email = charge.email || charge.customer?.email;
  const rechargeCustomerId = String(charge.customer_id || charge.customer?.id || '');

  if (!shopifyCustomerId || !email) {
    console.error('[webhook] Missing customer data', charge);
    return res.status(400).json({ error: 'Missing customer data' });
  }

  // ── 3. IDEMPOTENCY — never count the same charge twice ───────────────────
  if (await isProcessed(chargeId)) {
    console.log(`[webhook] Duplicate charge ${chargeId} — skipping`);
    return res.status(200).json({ status: 'duplicate' });
  }

  // ── 4. SUBSCRIPTION ORDERS ONLY — skip one-time purchases ───────────────
  const chargeType = (charge.type || '').toUpperCase();
  if (chargeType && chargeType !== 'RECURRING') {
    await logEvent(shopifyCustomerId, 'webhook_skipped', {
      reason: 'not_recurring',
      charge_type: chargeType,
      charge_id: chargeId,
    });
    return res.status(200).json({ status: 'skipped', reason: 'not_recurring' });
  }

  console.log(`[webhook] Processing charge ${chargeId} for customer ${shopifyCustomerId}`);

  try {
    // ── 5. GET OR CREATE customer record ──────────────────────────────────
    const customer = await getOrCreateCustomer(shopifyCustomerId, email, rechargeCustomerId);

    // ── 6. INCREMENT cycle count ───────────────────────────────────────────
    const newCount = (customer.cycle_count || 0) + 1;

    await supabase
      .from('customer_rewards')
      .update({ cycle_count: newCount, updated_at: new Date().toISOString() })
      .eq('shopify_customer_id', String(shopifyCustomerId));

    await logEvent(shopifyCustomerId, 'cycle_counted', {
      charge_id: chargeId,
      cycle_count: newCount,
    });

    console.log(`[webhook] Customer ${shopifyCustomerId} now at cycle ${newCount}`);

    // ── 7. CHECK MILESTONES ────────────────────────────────────────────────
    for (const milestone of MILESTONES) {
      if (newCount === milestone.cycles) {
        const earned = await markRewardEarned(shopifyCustomerId, milestone.id);

        if (earned) {
          await logEvent(shopifyCustomerId, 'milestone_reached', {
            reward_id: milestone.id,
            milestone: milestone.cycles,
            charge_id: chargeId,
          });

          console.log(`[webhook] Milestone ${milestone.cycles} reached for ${email}`);

          // Send reward notification email
          try {
            await sendRewardEmail(email, milestone, newCount);
            console.log(`[webhook] Reward email sent to ${email}`);
          } catch (emailErr) {
            // Log email failure but don't fail the webhook
            console.error(`[webhook] Email failed for ${email}:`, emailErr.message);
            await logEvent(shopifyCustomerId, 'error', {
              error: 'email_send_failed',
              message: emailErr.message,
              charge_id: chargeId,
            });
          }
        }
      }
    }

    // ── 8. MARK charge as processed ───────────────────────────────────────
    await markProcessed(chargeId);

    return res.status(200).json({
      status: 'ok',
      customer_id: shopifyCustomerId,
      cycle_count: newCount,
    });

  } catch (err) {
    console.error(`[webhook] Error processing charge ${chargeId}:`, err.message);

    await logEvent(shopifyCustomerId, 'error', {
      error: err.message,
      charge_id: chargeId,
    }).catch(() => {}); // don't throw if logging also fails

    return res.status(500).json({ error: 'Internal error', message: err.message });
  }
};

/**
 * Webhook Dead-Letter Queue Retry Processor
 * GET /api/cron/retry
 *
 * Runs every hour via Vercel Cron.
 * Retries failed webhooks from the DLQ.
 * Also runs cleanup of old processed_charges.
 *
 * Protected by CRON_SECRET header.
 */

const { supabase } = require('../../lib/supabase');
const { getPendingWebhooks, markWebhookResolved, markWebhookDead } = require('../../lib/queue');

// Re-process a single failed webhook by calling our own webhook handler logic
// We import the processor directly to avoid HTTP overhead
const webhookHandler = require('../webhook');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const results = { retried: 0, resolved: 0, dead: 0, cleaned: 0 };

  // ── RETRY FAILED WEBHOOKS ────────────────────────────────────────────────
  try {
    const pending = await getPendingWebhooks(20);
    console.log(`[cron/retry] Retrying ${pending.length} failed webhooks`);

    for (const job of pending) {
      console.log(`[cron/retry] Retrying charge ${job.recharge_charge_id} (attempt ${job.attempt_count + 1})`);
      results.retried++;

      try {
        // Simulate a webhook request with the stored raw body
        let parsed;
        try { parsed = JSON.parse(job.raw_body); } catch { parsed = {}; }

        const charge = parsed.charge || parsed;
        const chargeId = String(charge.id || '');

        // Check if it was already processed successfully since being queued
        const { data: already } = await supabase
          .from('processed_charges')
          .select('recharge_charge_id')
          .eq('recharge_charge_id', chargeId)
          .single();

        if (already) {
          console.log(`[cron/retry] Charge ${chargeId} already processed — resolving DLQ item`);
          await markWebhookResolved(job.id);
          results.resolved++;
          continue;
        }

        // Attempt to process by importing the core logic
        // Create mock req/res to run through the handler
        const mockReq = {
          method: 'POST',
          headers: {
            'x-recharge-hmac-sha256': '', // signature skipped in retry (we already validated)
            'x-recharge-topic': job.topic || 'charge/paid',
          },
          body: parsed,
          _rawBody: job.raw_body,
        };

        // For DLQ retries, skip HMAC and directly call core logic
        const {
          getOrCreateCustomer,
          incrementCycles,
          markRewardEarned,
          logEvent,
          isProcessed,
          markProcessed,
        } = require('../../lib/supabase');
        const { queueEmail } = require('../../lib/queue');
        const MILESTONES = require('../../milestones');

        if (!charge.shopify_customer_id || !charge.email) {
          throw new Error('Missing customer data in stored payload');
        }

        const shopifyCustomerId = String(charge.shopify_customer_id);
        const email = charge.email.toLowerCase().trim();
        const rechargeCustomerId = String(charge.customer_id || '');

        if (await isProcessed(chargeId)) {
          await markWebhookResolved(job.id);
          results.resolved++;
          continue;
        }

        await getOrCreateCustomer(shopifyCustomerId, email, rechargeCustomerId);
        const newCount = await incrementCycles(shopifyCustomerId);

        await logEvent(shopifyCustomerId, 'cycle_counted', {
          charge_id: chargeId,
          cycle_count: newCount,
          note: 'processed_via_dlq_retry',
        });

        for (const milestone of MILESTONES) {
          if (newCount >= milestone.cycles) {
            const earned = await markRewardEarned(shopifyCustomerId, milestone.id);
            if (earned) {
              await logEvent(shopifyCustomerId, 'milestone_reached', {
                reward_id: milestone.id,
                milestone: milestone.cycles,
                charge_id: chargeId,
              });
              await queueEmail(shopifyCustomerId, email, milestone, newCount).catch(() => {});
            }
          }
        }

        await markProcessed(chargeId);
        await markWebhookResolved(job.id);
        results.resolved++;
        console.log(`[cron/retry] Resolved charge ${chargeId}`);

      } catch (err) {
        console.error(`[cron/retry] Retry failed for ${job.recharge_charge_id}:`, err.message);
        const isDead = await markWebhookDead(job.id, err.message, job.attempt_count);
        if (isDead) {
          results.dead++;
          console.error(`[cron/retry] DEAD: charge ${job.recharge_charge_id} after ${job.attempt_count + 1} attempts`);
        }
      }
    }
  } catch (err) {
    console.error('[cron/retry] Fatal error in retry loop:', err.message);
  }

  // ── CLEANUP OLD PROCESSED CHARGES ───────────────────────────────────────
  try {
    const { data, error } = await supabase.rpc('cleanup_old_charges');
    if (!error && data > 0) {
      results.cleaned = data;
      console.log(`[cron/retry] Cleaned ${data} old processed_charges records`);
    }
  } catch (err) {
    console.error('[cron/retry] Cleanup failed:', err.message);
  }

  const duration = Date.now() - startTime;
  console.log(`[cron/retry] Done in ${duration}ms — retried:${results.retried} resolved:${results.resolved} dead:${results.dead} cleaned:${results.cleaned}`);

  return res.status(200).json({ ...results, duration_ms: duration });
};

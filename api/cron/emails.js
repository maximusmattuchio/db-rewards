/**
 * Email Queue Processor
 * GET /api/cron/emails
 *
 * Runs every 5 minutes via Vercel Cron.
 * Processes pending emails from the queue — retries with exponential backoff.
 * Dead-letters after 5 failed attempts.
 *
 * Protected by CRON_SECRET header so only Vercel can call it.
 */

const MILESTONES = require('../../milestones');
const { sendRewardEmail } = require('../../lib/email');
const { getPendingEmails, markEmailSent, markEmailFailed } = require('../../lib/queue');
const { logEvent } = require('../../lib/supabase');

module.exports = async function handler(req, res) {
  // Only GET allowed (Vercel Cron uses GET)
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Validate cron secret — prevent unauthorized runs
  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const results = { sent: 0, failed: 0, dead: 0, errors: [] };

  try {
    const pending = await getPendingEmails(50);
    console.log(`[cron/emails] Processing ${pending.length} queued emails`);

    for (const job of pending) {
      const milestone = MILESTONES.find(m => m.id === job.milestone_id);

      if (!milestone) {
        console.error(`[cron/emails] Unknown milestone: ${job.milestone_id}`);
        await markEmailFailed(job.id, `Unknown milestone: ${job.milestone_id}`, job.attempt_count);
        results.failed++;
        continue;
      }

      try {
        await sendRewardEmail(job.email, milestone, job.cycle_count, job.shopify_customer_id);
        await markEmailSent(job.id);

        await logEvent(job.shopify_customer_id, 'reward_email_sent', {
          reward_id: job.reward_id,
          milestone: milestone.cycles,
        });

        console.log(`[cron/emails] Sent to ${job.email} (${milestone.id})`);
        results.sent++;

      } catch (err) {
        console.error(`[cron/emails] Failed to send to ${job.email}:`, err.message);

        const isDead = await markEmailFailed(job.id, err.message, job.attempt_count, job.max_attempts);

        if (isDead) {
          results.dead++;
          console.error(`[cron/emails] DEAD: ${job.email} (${milestone.id}) after ${job.attempt_count + 1} attempts`);

          await logEvent(job.shopify_customer_id, 'error', {
            error: 'email_permanently_failed',
            message: `Email dead-lettered after ${job.attempt_count + 1} attempts: ${err.message}`,
            reward_id: job.reward_id,
          });
        } else {
          results.failed++;
        }

        results.errors.push({ email: job.email, error: err.message });
      }
    }

  } catch (err) {
    console.error('[cron/emails] Fatal error:', err.message);
    return res.status(500).json({ error: err.message, results });
  }

  const duration = Date.now() - startTime;
  console.log(`[cron/emails] Done in ${duration}ms — sent:${results.sent} failed:${results.failed} dead:${results.dead}`);

  return res.status(200).json({ ...results, duration_ms: duration });
};

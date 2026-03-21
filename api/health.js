/**
 * Health Check Endpoint
 * GET /api/health
 *
 * Returns system status, queue depths, and recent error counts.
 * Used for monitoring and alerting.
 * Safe to call publicly — returns no sensitive data.
 */

const { supabase } = require('../lib/supabase');
const { getQueueDepths } = require('../lib/queue');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const startTime = Date.now();
  const status = { ok: true, checks: {} };

  // ── DATABASE CONNECTIVITY ────────────────────────────────────────────────
  try {
    const { count, error } = await supabase
      .from('customer_rewards')
      .select('*', { count: 'exact', head: true });

    status.checks.database = error
      ? { ok: false, error: error.message }
      : { ok: true, total_customers: count };
  } catch (err) {
    status.checks.database = { ok: false, error: err.message };
    status.ok = false;
  }

  // ── QUEUE DEPTHS ─────────────────────────────────────────────────────────
  try {
    const depths = await getQueueDepths();
    status.checks.queues = { ok: true, ...depths };

    // Flag as degraded if dead queues are growing
    if (depths.emails_dead > 10 || depths.webhooks_dead > 5) {
      status.checks.queues.warning = 'Dead queue items require manual review';
      status.ok = false;
    }
  } catch (err) {
    status.checks.queues = { ok: false, error: err.message };
    status.ok = false;
  }

  // ── RECENT ERROR RATE ────────────────────────────────────────────────────
  try {
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    const { count: errorCount } = await supabase
      .from('reward_events')
      .select('*', { count: 'exact', head: true })
      .eq('event_type', 'error')
      .gte('created_at', oneHourAgo);

    const { count: totalCount } = await supabase
      .from('reward_events')
      .select('*', { count: 'exact', head: true })
      .gte('created_at', oneHourAgo);

    status.checks.errors = {
      ok: true,
      last_hour_errors: errorCount || 0,
      last_hour_events: totalCount || 0,
      error_rate: totalCount > 0 ? ((errorCount / totalCount) * 100).toFixed(1) + '%' : '0%',
    };

    if (errorCount > 10) {
      status.checks.errors.warning = 'High error rate — check recent_errors view in Supabase';
      status.ok = false;
    }
  } catch (err) {
    status.checks.errors = { ok: false, error: err.message };
  }

  const duration = Date.now() - startTime;
  status.response_ms = duration;
  status.timestamp = new Date().toISOString();

  return res.status(status.ok ? 200 : 503).json(status);
};

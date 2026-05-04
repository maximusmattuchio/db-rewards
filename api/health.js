/**
 * GET  /api/health  — system status, queue depths, recent error counts
 * POST /api/health  — backer code redemption (rewritten from /api/redeem)
 *
 * Dispatched by HTTP method. Two endpoints share one function file because
 * the project is at the Hobby-plan 12-function limit. /api/redeem is
 * routed here via vercel.json rewrites.
 */

const { supabase } = require('../lib/supabase');
const { getQueueDepths } = require('../lib/queue');
const { toLoomEmbed } = require('../lib/loom');
const { check, getClientIp } = require('../lib/rate-limit');

module.exports = async function handler(req, res) {
  if (req.method === 'POST') return handleRedeem(req, res);
  if (req.method === 'GET') return handleHealth(req, res);
  return res.status(405).json({ error: 'Method not allowed' });
};

// ── POST: backer code redemption ─────────────────────────────────────────
async function handleRedeem(req, res) {
  const ip = getClientIp(req);
  const limit = check(ip, { limit: 5, windowMs: 60_000 });
  if (!limit.allowed) {
    res.setHeader('Retry-After', Math.ceil((limit.resetAt - Date.now()) / 1000));
    return res.status(429).json({ error: 'Too many attempts. Try again in a minute.' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  const rawCode = body && typeof body.code === 'string' ? body.code : '';
  const code = rawCode.trim();

  if (!/^\d{4}$/.test(code)) {
    return res.status(400).json({ error: 'Enter the 4-digit code from your insert.' });
  }

  try {
    const { data, error } = await supabase
      .from('backer_codes')
      .select('code, backer_name, loom_video_url, redeem_count')
      .eq('code', code)
      .maybeSingle();

    if (error) {
      console.error('[redeem] supabase select failed:', error.message);
      return res.status(500).json({ error: 'Something went wrong. Try again.' });
    }

    if (!data) {
      return res.status(404).json({ error: "We don't recognize that code." });
    }

    const embedUrl = toLoomEmbed(data.loom_video_url);
    if (!embedUrl) {
      console.error('[redeem] invalid loom url for code', code, data.loom_video_url);
      return res.status(500).json({ error: 'Video unavailable. Email hello@getdirtybastard.com.' });
    }

    // Fire-and-forget redemption tracking — don't block the response on it.
    const isFirst = data.redeem_count === 0;
    supabase
      .from('backer_codes')
      .update({
        redeem_count: data.redeem_count + 1,
        ...(isFirst ? { first_redeemed_at: new Date().toISOString() } : {}),
      })
      .eq('code', code)
      .then(({ error: updateError }) => {
        if (updateError) console.error('[redeem] update failed:', updateError.message);
      });

    return res.status(200).json({
      backer_name: data.backer_name,
      loom_embed_url: embedUrl,
    });
  } catch (err) {
    console.error('[redeem] unexpected error:', err.message);
    return res.status(500).json({ error: 'Something went wrong. Try again.' });
  }
}

// ── GET: original health check ───────────────────────────────────────────
async function handleHealth(req, res) {
  const startTime = Date.now();
  const status = { ok: true, checks: {} };

  // ── DATABASE CONNECTIVITY ────────────────────────────────────────────
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

  // ── QUEUE DEPTHS ─────────────────────────────────────────────────────
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

  // ── RECENT ERROR RATE ────────────────────────────────────────────────
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
}

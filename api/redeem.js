/**
 * Backer code redemption endpoint
 * POST /api/redeem  body: { code: string }
 *
 * Validates the code, increments redeem_count for analytics, returns the
 * backer's name + a Loom embed URL. Codes are reusable — backers can rewatch.
 */

const { supabase } = require('../lib/supabase');
const { toLoomEmbed } = require('../lib/loom');
const { check, getClientIp } = require('../lib/rate-limit');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

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
};

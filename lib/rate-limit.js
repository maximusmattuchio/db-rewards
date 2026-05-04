/**
 * Tiny in-memory IP rate limiter.
 *
 * Vercel serverless functions don't share memory across instances, so this is
 * "best effort" — a determined attacker could hit cold instances. Good enough
 * for the backer-unlock flow (~70 codes, friendly audience). If abuse shows up
 * later, swap for Vercel KV / Upstash.
 */

const buckets = new Map();

function check(ip, { limit = 5, windowMs = 60_000 } = {}) {
  const now = Date.now();
  const entry = buckets.get(ip);

  if (!entry || now > entry.resetAt) {
    buckets.set(ip, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: limit - 1, resetAt: now + windowMs };
  }

  if (entry.count >= limit) {
    return { allowed: false, remaining: 0, resetAt: entry.resetAt };
  }

  entry.count += 1;
  return { allowed: true, remaining: limit - entry.count, resetAt: entry.resetAt };
}

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    return fwd.split(',')[0].trim();
  }
  return req.headers['x-real-ip'] || req.socket?.remoteAddress || 'unknown';
}

module.exports = { check, getClientIp };

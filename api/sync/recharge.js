/**
 * ReCharge Sync — Charges + Subscriptions
 * GET /api/sync/recharge
 *
 * Charges:     incremental by updated_at high-water mark, cursor pagination
 * Subscriptions: full upsert (status changes on existing records must be captured)
 *
 * Protected by CRON_SECRET.
 */

const { supabase } = require('../../lib/supabase');

const RC_TOKEN  = process.env.RECHARGE_API_TOKEN;
const RC_BASE   = 'https://api.rechargeapps.com';
const PAGE_SIZE = 250;
const RATE_LIMIT_MS = 500; // ReCharge API rate limits are stricter

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const RC_HEADERS = {
  'X-Recharge-Access-Token': RC_TOKEN || '',
  'Accept': 'application/json',
};

async function rcGet(path) {
  const res = await fetch(`${RC_BASE}${path}`, {
    headers: RC_HEADERS,
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`ReCharge API ${res.status} for ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// ─── SYNC STATE ───────────────────────────────────────────────────────────────

async function getHighWaterMark(syncKey) {
  const { data } = await supabase
    .from('sync_state')
    .select('last_synced_at')
    .eq('sync_key', syncKey)
    .single();
  return data?.last_synced_at || null;
}

async function setHighWaterMark(syncKey, ts, recordsSynced, error = null) {
  await supabase
    .from('sync_state')
    .update({
      last_synced_at: error ? undefined : ts,
      last_run_at:    new Date().toISOString(),
      records_synced: recordsSynced,
      error:          error || null,
      updated_at:     new Date().toISOString(),
    })
    .eq('sync_key', syncKey);
}

// ─── CHARGES SYNC ─────────────────────────────────────────────────────────────

function mapCharge(c) {
  return {
    recharge_charge_id:   String(c.id),
    recharge_customer_id: String(c.customer_id || ''),
    shopify_customer_id:  c.shopify_customer_id ? String(c.shopify_customer_id) : null,
    email:                c.email || null,
    status:               c.status || null,
    amount:               c.total_price ? Number(c.total_price) : null,
    currency:             c.currency || 'USD',
    scheduled_at:         c.scheduled_at || null,
    processed_at:         c.processed_at || null,
    error_type:           c.error_type || null,
    created_at:           c.created_at || null,
    updated_at:           c.updated_at || null,
    synced_at:            new Date().toISOString(),
  };
}

const CHARGE_STATUSES = ['success', 'error', 'refunded', 'partially_refunded', 'queued'];

async function syncChargesByStatus(status, since) {
  let cursor = null;
  let total = 0;
  let latestUpdatedAt = null;

  do {
    let path = `/charges?limit=${PAGE_SIZE}&status=${status}`;
    if (since) path += `&updated_at_min=${encodeURIComponent(since)}`;
    if (cursor) path += `&cursor=${cursor}`;

    const data = await rcGet(path);
    const charges = data.charges || [];

    if (charges.length > 0) {
      const rows = charges.map(mapCharge);
      const { error } = await supabase
        .from('recharge_charges_sync')
        .upsert(rows, { onConflict: 'recharge_charge_id' });
      if (error) throw new Error(`Charges upsert failed (${status}): ${error.message}`);
      total += rows.length;

      for (const c of charges) {
        if (c.updated_at && (!latestUpdatedAt || c.updated_at > latestUpdatedAt)) {
          latestUpdatedAt = c.updated_at;
        }
      }
    }

    cursor = data.next_cursor || null;
    if (cursor) await sleep(RATE_LIMIT_MS);

  } while (cursor);

  return { total, latestUpdatedAt };
}

async function syncCharges() {
  const since = await getHighWaterMark('recharge_charges');
  let total = 0;
  let latestUpdatedAt = null;

  for (const status of CHARGE_STATUSES) {
    const result = await syncChargesByStatus(status, since);
    total += result.total;
    if (result.latestUpdatedAt && (!latestUpdatedAt || result.latestUpdatedAt > latestUpdatedAt)) {
      latestUpdatedAt = result.latestUpdatedAt;
    }
    if (CHARGE_STATUSES.indexOf(status) < CHARGE_STATUSES.length - 1) await sleep(RATE_LIMIT_MS);
  }

  const newWatermark = latestUpdatedAt || new Date().toISOString();
  await setHighWaterMark('recharge_charges', newWatermark, total);
  return total;
}

// ─── SUBSCRIPTIONS SYNC ───────────────────────────────────────────────────────

function mapSubscription(s) {
  return {
    recharge_subscription_id:     String(s.id),
    recharge_customer_id:         String(s.customer_id || ''),
    shopify_customer_id:          s.shopify_customer_id ? String(s.shopify_customer_id) : null,
    email:                        s.email || null,
    status:                       s.status || null,
    product_title:                s.product_title || null,
    variant_title:                s.variant_title || null,
    price:                        s.price ? Number(s.price) : null,
    order_interval_frequency:     s.order_interval_frequency ? Number(s.order_interval_frequency) : null,
    order_interval_unit:          s.order_interval_unit || null,
    cancellation_reason:          s.cancellation_reason || null,
    cancellation_reason_comments: s.cancellation_reason_comments || null,
    cancelled_at:                 s.cancelled_at || null,
    created_at:                   s.created_at || null,
    updated_at:                   s.updated_at || null,
    synced_at:                    new Date().toISOString(),
  };
}

const SUBSCRIPTION_STATUSES = ['active', 'cancelled', 'expired'];

async function syncSubscriptionsByStatus(status, since) {
  let cursor = null;
  let total = 0;

  do {
    let path = `/subscriptions?limit=${PAGE_SIZE}&status=${status}`;
    if (since) path += `&updated_at_min=${encodeURIComponent(since)}`;
    if (cursor) path += `&cursor=${cursor}`;

    const data = await rcGet(path);
    const subs = data.subscriptions || [];

    if (subs.length > 0) {
      const rows = subs.map(mapSubscription);
      const { error } = await supabase
        .from('recharge_subscriptions_sync')
        .upsert(rows, { onConflict: 'recharge_subscription_id' });
      if (error) throw new Error(`Subscriptions upsert failed (${status}): ${error.message}`);
      total += rows.length;
    }

    cursor = data.next_cursor || null;
    if (cursor) await sleep(RATE_LIMIT_MS);

  } while (cursor);

  return total;
}

async function syncSubscriptions() {
  const since = await getHighWaterMark('recharge_subscriptions');
  let total = 0;

  for (const status of SUBSCRIPTION_STATUSES) {
    total += await syncSubscriptionsByStatus(status, since);
    if (SUBSCRIPTION_STATUSES.indexOf(status) < SUBSCRIPTION_STATUSES.length - 1) await sleep(RATE_LIMIT_MS);
  }

  await setHighWaterMark('recharge_subscriptions', new Date().toISOString(), total);
  return total;
}

// ─── HANDLER ─────────────────────────────────────────────────────────────────

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!RC_TOKEN) return res.status(500).json({ error: 'RECHARGE_API_TOKEN not configured' });

  const startTime = Date.now();
  const results = { charges: 0, subscriptions: 0, errors: [] };

  try {
    results.charges = await syncCharges();
    console.log(`[sync/recharge] Charges: ${results.charges}`);
  } catch (err) {
    console.error('[sync/recharge] Charges sync error:', err.message);
    results.errors.push({ type: 'charges', error: err.message });
    await setHighWaterMark('recharge_charges', null, 0, err.message);
  }

  try {
    results.subscriptions = await syncSubscriptions();
    console.log(`[sync/recharge] Subscriptions: ${results.subscriptions}`);
  } catch (err) {
    console.error('[sync/recharge] Subscriptions sync error:', err.message);
    results.errors.push({ type: 'subscriptions', error: err.message });
    await setHighWaterMark('recharge_subscriptions', null, 0, err.message);
  }

  const duration = Date.now() - startTime;
  console.log(`[sync/recharge] Done in ${duration}ms`);
  return res.status(200).json({ ...results, duration_ms: duration });
};

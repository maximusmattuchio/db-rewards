/**
 * Shopify Orders Sync
 * GET /api/sync/shopify
 *
 * Incremental sync of Shopify orders into shopify_orders_sync.
 * Uses updated_at high-water mark stored in sync_state.
 * Paginates via Link header (cursor-based).
 * Rate-limited to ~400ms between pages (Shopify allows 2 req/s on standard plan).
 *
 * Protected by CRON_SECRET.
 */

const { supabase } = require('../../lib/supabase');

const SHOPIFY_STORE   = process.env.SHOPIFY_STORE_DOMAIN;   // e.g. dirty-bastard-laundry-co.myshopify.com
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ADMIN_TOKEN;
const PAGE_SIZE       = 250;
const RATE_LIMIT_MS   = 400;
const SYNC_KEY        = 'shopify_orders';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function getHighWaterMark() {
  const { data } = await supabase
    .from('sync_state')
    .select('last_synced_at')
    .eq('sync_key', SYNC_KEY)
    .single();
  return data?.last_synced_at || null;
}

async function setHighWaterMark(ts, recordsSynced, error = null) {
  await supabase
    .from('sync_state')
    .update({
      last_synced_at: error ? undefined : ts,
      last_run_at:    new Date().toISOString(),
      records_synced: recordsSynced,
      error:          error || null,
      updated_at:     new Date().toISOString(),
    })
    .eq('sync_key', SYNC_KEY);
}

function buildFirstUrl(since) {
  const base = `https://${SHOPIFY_STORE}/admin/api/2024-01/orders.json`;
  const params = new URLSearchParams({
    status: 'any',
    limit:  PAGE_SIZE,
    fields: 'id,customer,email,financial_status,fulfillment_status,total_price,currency,order_number,tags,created_at,updated_at',
  });
  if (since) params.set('updated_at_min', since);
  return `${base}?${params}`;
}

function extractNextLink(linkHeader) {
  if (!linkHeader) return null;
  const match = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
  return match ? match[1] : null;
}

function mapOrder(o) {
  return {
    shopify_order_id:     String(o.id),
    shopify_customer_id:  o.customer ? String(o.customer.id) : null,
    email:                o.email || o.customer?.email || null,
    financial_status:     o.financial_status || null,
    fulfillment_status:   o.fulfillment_status || null,
    total_price:          o.total_price ? Number(o.total_price) : null,
    currency:             o.currency || 'USD',
    order_number:         o.order_number || null,
    tags:                 o.tags || null,
    created_at:           o.created_at || null,
    updated_at:           o.updated_at || null,
    synced_at:            new Date().toISOString(),
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader  = req.headers.authorization;
  const cronSecret  = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  if (!SHOPIFY_STORE || !SHOPIFY_TOKEN) {
    return res.status(500).json({ error: 'SHOPIFY_STORE_DOMAIN or SHOPIFY_ADMIN_TOKEN not configured' });
  }

  const startTime = Date.now();
  let total = 0;
  let pageCount = 0;
  let latestUpdatedAt = null;

  try {
    const since = await getHighWaterMark();
    console.log(`[sync/shopify] Starting sync. Since: ${since || 'beginning'}`);

    let url = buildFirstUrl(since);

    while (url) {
      const res2 = await fetch(url, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json',
        },
        signal: AbortSignal.timeout(15000),
      });

      if (!res2.ok) {
        const body = await res2.text().catch(() => '');
        throw new Error(`Shopify API ${res2.status}: ${body.slice(0, 200)}`);
      }

      const data = await res2.json();
      const orders = data.orders || [];
      pageCount++;

      if (orders.length > 0) {
        const rows = orders
          .filter(o => o.customer?.id)
          .map(mapOrder);

        if (rows.length > 0) {
          const { error: upsertErr } = await supabase
            .from('shopify_orders_sync')
            .upsert(rows, { onConflict: 'shopify_order_id' });

          if (upsertErr) throw new Error(`Supabase upsert failed: ${upsertErr.message}`);
          total += rows.length;
        }

        // Track the highest updated_at seen for the next high-water mark
        for (const o of orders) {
          if (o.updated_at && (!latestUpdatedAt || o.updated_at > latestUpdatedAt)) {
            latestUpdatedAt = o.updated_at;
          }
        }
      }

      // Read next page link from Link header
      const linkHeader = res2.headers.get('link') || '';
      url = extractNextLink(linkHeader);

      if (url) await sleep(RATE_LIMIT_MS);
    }

    const newWatermark = latestUpdatedAt || new Date().toISOString();
    await setHighWaterMark(newWatermark, total);

    const duration = Date.now() - startTime;
    console.log(`[sync/shopify] Done — ${total} orders across ${pageCount} pages in ${duration}ms`);
    return res.status(200).json({ synced: total, pages: pageCount, duration_ms: duration });

  } catch (err) {
    console.error('[sync/shopify] Error:', err.message);
    await setHighWaterMark(null, total, err.message);
    return res.status(500).json({ error: err.message, synced: total });
  }
};

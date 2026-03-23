/**
 * Customer Rewards Read Endpoint
 * GET /api/customer?id=SHOPIFY_CUSTOMER_ID
 *
 * Returns cycle count + earned rewards (Supabase) + live subscription
 * status (ReCharge API) for a given customer.
 */

const { getCycleCount } = require('../lib/supabase');
const MILESTONES = require('../milestones');

const RC_TOKEN = process.env.RECHARGE_API_TOKEN;
const RC_BASE  = 'https://api.rechargeapps.com';
const RC_HEADERS = {
  'X-Recharge-Access-Token': RC_TOKEN || '',
  'Accept': 'application/json',
};

// Fetch live subscription data from ReCharge by Shopify customer ID
async function getRechargeSubscription(shopifyCustomerId) {
  if (!RC_TOKEN) return null;

  try {
    // 1. Look up ReCharge customer by Shopify customer ID
    const custRes = await fetch(
      `${RC_BASE}/customers?shopify_customer_id=${shopifyCustomerId}`,
      { headers: RC_HEADERS, signal: AbortSignal.timeout(5000) }
    );
    if (!custRes.ok) return null;

    const custData = await custRes.json();
    const rcCustomer = (custData.customers || [])[0];
    if (!rcCustomer) return null;

    const rcCustomerId = rcCustomer.id;

    // 2. Fetch active subscriptions for this customer (run in parallel with next charge)
    const [subRes, chargeRes] = await Promise.all([
      fetch(`${RC_BASE}/subscriptions?customer_id=${rcCustomerId}&status=active`, {
        headers: RC_HEADERS,
        signal: AbortSignal.timeout(5000),
      }),
      fetch(`${RC_BASE}/charges?customer_id=${rcCustomerId}&status=queued&limit=1`, {
        headers: RC_HEADERS,
        signal: AbortSignal.timeout(5000),
      }),
    ]);

    const subData   = subRes.ok   ? await subRes.json()    : {};
    const chargeData = chargeRes.ok ? await chargeRes.json() : {};

    const subscription = (subData.subscriptions || [])[0];
    const nextCharge   = (chargeData.charges || [])[0];

    if (!subscription && !nextCharge) {
      // Check for paused subscriptions
      const pausedRes = await fetch(
        `${RC_BASE}/subscriptions?customer_id=${rcCustomerId}&status=paused`,
        { headers: RC_HEADERS, signal: AbortSignal.timeout(5000) }
      );
      const pausedData = pausedRes.ok ? await pausedRes.json() : {};
      const paused = (pausedData.subscriptions || [])[0];
      if (paused) {
        return {
          subscription_status: 'paused',
          product_title: paused.product_title || null,
          frequency: paused.order_interval_frequency
            ? `${paused.order_interval_frequency} ${paused.order_interval_unit}`
            : null,
          next_charge_date: null,
          shipping_address: rcCustomer.shipping_address || null,
        };
      }
      return { subscription_status: null };
    }

    return {
      subscription_status: subscription ? 'active' : null,
      product_title: subscription ? subscription.product_title : null,
      frequency: subscription
        ? `${subscription.order_interval_frequency} ${subscription.order_interval_unit}`
        : null,
      next_charge_date: nextCharge ? nextCharge.scheduled_at : null,
      shipping_address: rcCustomer.shipping_address || null,
    };

  } catch (err) {
    console.error('[customer] ReCharge fetch error:', err.message);
    return null; // Non-fatal — rewards data still returns
  }
}

module.exports = async function handler(req, res) {
  const origin = req.headers.origin || '';
  const allowed = ['https://getdirtybastard.com', 'https://dirty-bastard-laundry-co.myshopify.com'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const customerId = req.query.id;
  if (!customerId || !/^\d+$/.test(customerId)) {
    return res.status(400).json({ error: 'Invalid customer id' });
  }

  try {
    // Fetch Supabase rewards + ReCharge subscription in parallel
    const [rewardsData, rcData] = await Promise.all([
      getCycleCount(customerId),
      getRechargeSubscription(customerId),
    ]);

    const cycle_count       = rewardsData?.cycle_count || 0;
    const rewards_earned    = rewardsData?.rewards_earned || [];
    const rewards_fulfilled = rewardsData?.rewards_fulfilled || [];

    const next = MILESTONES.find(m => cycle_count < m.cycles) || null;
    const cyclesToNext = next ? next.cycles - cycle_count : 0;

    return res.status(200).json({
      found: !!rewardsData,
      cycle_count,
      rewards_earned,
      rewards_fulfilled,
      milestones: MILESTONES.map(m => ({
        ...m,
        earned:    rewards_earned.includes(m.id),
        fulfilled: rewards_fulfilled.includes(m.id),
        progress:  Math.min(cycle_count, m.cycles),
      })),
      next_milestone:  next,
      cycles_to_next:  cyclesToNext,

      // ReCharge live data (null fields if no subscription / API unavailable)
      subscription_status: rcData?.subscription_status || null,
      product_title:       rcData?.product_title || null,
      frequency:           rcData?.frequency || null,
      next_charge_date:    rcData?.next_charge_date || null,
      shipping_address:    rcData?.shipping_address || null,
    });

  } catch (err) {
    console.error('[customer] Error:', err.message);
    return res.status(500).json({ error: 'Failed to load rewards data' });
  }
};

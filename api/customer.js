/**
 * Customer Rewards Read Endpoint
 * GET /api/customer?id=SHOPIFY_CUSTOMER_ID
 *
 * Returns cycle count + earned rewards (Supabase) + all subscriptions
 * (ReCharge API) for a given customer. Supports multiple subscriptions
 * per account (e.g. a parent managing two kids' subscriptions).
 */

const { getCycleCount } = require('../lib/supabase');
const MILESTONES = require('../milestones');

const RC_TOKEN = process.env.RECHARGE_API_TOKEN;
const RC_BASE  = 'https://api.rechargeapps.com';
const RC_HEADERS = {
  'X-Recharge-Access-Token': RC_TOKEN || '',
  'Accept': 'application/json',
};

async function rcGet(path) {
  const res = await fetch(`${RC_BASE}${path}`, {
    headers: RC_HEADERS,
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return {};
  return res.json().catch(() => ({}));
}

async function getRechargeSubscriptions(shopifyCustomerId) {
  if (!RC_TOKEN) return [];

  try {
    // 1. Look up ReCharge customer
    const custData = await rcGet(`/customers?shopify_customer_id=${shopifyCustomerId}`);
    const rcCustomer = (custData.customers || [])[0];
    if (!rcCustomer) return [];

    const rcCustomerId = rcCustomer.id;

    // 2. Fetch active subs, all queued charges, and all addresses in parallel
    const [activeData, chargeData, addrData] = await Promise.all([
      rcGet(`/subscriptions?customer_id=${rcCustomerId}&status=active`),
      rcGet(`/charges?customer_id=${rcCustomerId}&status=queued`),
      rcGet(`/addresses?customer_id=${rcCustomerId}`),
    ]);

    let subs = activeData.subscriptions || [];

    // Fall back to paused if no active
    if (subs.length === 0) {
      const pausedData = await rcGet(`/subscriptions?customer_id=${rcCustomerId}&status=paused`);
      subs = pausedData.subscriptions || [];
    }

    if (subs.length === 0) return [];

    const charges   = chargeData.charges || [];
    const addresses = addrData.addresses || [];

    // Build a map of addressId → address object
    const addrMap = {};
    addresses.forEach(a => { addrMap[a.id] = a; });

    // Map each subscription to its next charge and address
    return subs.map(sub => {
      // Find the queued charge that contains this subscription's line item
      const nextCharge = charges.find(c =>
        (c.line_items || []).some(li => li.subscription_id === sub.id)
      ) || null;

      const addr = addrMap[sub.address_id] || null;

      return {
        id:               sub.id,
        status:           sub.status,
        product_title:    sub.product_title || null,
        variant_title:    sub.variant_title || null,
        frequency:        sub.order_interval_frequency
                            ? `${sub.order_interval_frequency} ${sub.order_interval_unit}`
                            : null,
        address_id:       sub.address_id || null,
        next_charge_id:   nextCharge ? nextCharge.id : null,
        next_charge_date: nextCharge ? nextCharge.scheduled_at : null,
        shipping_address: addr ? {
          first_name: addr.first_name,
          last_name:  addr.last_name,
          address1:   addr.address1,
          address2:   addr.address2,
          city:       addr.city,
          province:   addr.province,
          zip:        addr.zip,
          country:    addr.country,
          phone:      addr.phone,
        } : null,
      };
    });

  } catch (err) {
    console.error('[customer] ReCharge fetch error:', err.message);
    return { subs: [], error: true };
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
    const [rewardsData, rcResult] = await Promise.all([
      getCycleCount(customerId),
      getRechargeSubscriptions(customerId),
    ]);

    const subscriptions      = Array.isArray(rcResult) ? rcResult : (rcResult?.subs || []);
    const subscriptions_error = !Array.isArray(rcResult) && rcResult?.error === true;

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
      next_milestone: next,
      cycles_to_next: cyclesToNext,
      subscriptions,
      subscriptions_error,
    });

  } catch (err) {
    console.error('[customer] Error:', err.message);
    return res.status(500).json({ error: 'Failed to load rewards data' });
  }
};

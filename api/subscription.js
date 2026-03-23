/**
 * Subscription Management Endpoint
 * POST /api/subscription
 * Body: { customerId, action, ...params }
 *
 * Actions: skip | pause | resume | frequency | swap | address | products
 */

const RC_TOKEN  = process.env.RECHARGE_API_TOKEN;
const RC_BASE   = 'https://api.rechargeapps.com';
const RC_HEADS  = {
  'X-Recharge-Access-Token': RC_TOKEN || '',
  'Content-Type': 'application/json',
  'Accept': 'application/json',
};

async function rcFetch(path, opts) {
  const res = await fetch(`${RC_BASE}${path}`, {
    ...opts,
    headers: { ...RC_HEADS, ...(opts && opts.headers) },
    signal: AbortSignal.timeout(8000),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || body.errors || `RC ${res.status}`);
  return body;
}

async function getRechargeData(shopifyCustomerId) {
  const custData = await rcFetch(`/customers?shopify_customer_id=${shopifyCustomerId}`);
  const rc = (custData.customers || [])[0];
  if (!rc) throw new Error('No ReCharge account found for this customer');

  const [subData, chargeData] = await Promise.all([
    rcFetch(`/subscriptions?customer_id=${rc.id}&status=active`).catch(() => ({})),
    rcFetch(`/charges?customer_id=${rc.id}&status=queued&limit=1`).catch(() => ({})),
  ]);

  let sub = (subData.subscriptions || [])[0];

  // Fall back to paused subscription
  if (!sub) {
    const pausedData = await rcFetch(`/subscriptions?customer_id=${rc.id}&status=paused`).catch(() => ({}));
    sub = (pausedData.subscriptions || [])[0];
  }

  const nextCharge = (chargeData.charges || [])[0];

  return {
    rcCustomerId:  rc.id,
    subscriptionId: sub ? sub.id : null,
    addressId:     sub ? sub.address_id : (rc.shipping_address ? rc.shipping_address.id : null),
    nextChargeId:  nextCharge ? nextCharge.id : null,
    status:        sub ? sub.status : null,
  };
}

module.exports = async function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = ['https://getdirtybastard.com', 'https://dirty-bastard-laundry-co.myshopify.com'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { customerId, action, ...params } = req.body || {};

  if (!customerId || !/^\d+$/.test(String(customerId))) {
    return res.status(400).json({ error: 'Invalid customer id' });
  }
  if (!action) return res.status(400).json({ error: 'action required' });

  try {
    // Products action doesn't need a subscription
    if (action === 'products') {
      const data = await rcFetch('/products?limit=50');
      const products = (data.products || [])
        .filter(p => p.shopify_product_id)
        .map(p => ({
          title:    p.title,
          variants: (p.variants || []).map(v => ({
            id:    v.shopify_variant_id,
            title: v.title,
          })),
        }));
      return res.status(200).json({ success: true, products });
    }

    const rc = await getRechargeData(String(customerId));

    if (!rc.subscriptionId && action !== 'address') {
      return res.status(404).json({ error: 'No active subscription found' });
    }

    let result;

    switch (action) {

      case 'skip': {
        if (!rc.nextChargeId) {
          return res.status(400).json({ error: 'No upcoming charge to skip — check back closer to your next billing date' });
        }
        await rcFetch(`/charges/${rc.nextChargeId}/skip`, {
          method: 'POST',
          body: JSON.stringify({ subscription_id: rc.subscriptionId }),
        });
        result = { success: true, message: 'Next cycle skipped' };
        break;
      }

      case 'pause': {
        await rcFetch(`/subscriptions/${rc.subscriptionId}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'paused' }),
        });
        result = { success: true, message: 'Subscription paused' };
        break;
      }

      case 'resume': {
        await rcFetch(`/subscriptions/${rc.subscriptionId}`, {
          method: 'PUT',
          body: JSON.stringify({ status: 'active' }),
        });
        result = { success: true, message: 'Subscription resumed' };
        break;
      }

      case 'frequency': {
        const freq = parseInt(params.weeks, 10);
        if (![4, 6, 8].includes(freq)) {
          return res.status(400).json({ error: 'Frequency must be 4, 6, or 8 weeks' });
        }
        await rcFetch(`/subscriptions/${rc.subscriptionId}`, {
          method: 'PUT',
          body: JSON.stringify({
            order_interval_frequency:  freq,
            charge_interval_frequency: freq,
            order_interval_unit:       'week',
          }),
        });
        result = { success: true, message: `Delivery frequency updated to every ${freq} weeks` };
        break;
      }

      case 'swap': {
        const variantId = parseInt(params.variantId, 10);
        if (!variantId) return res.status(400).json({ error: 'Invalid variant id' });
        await rcFetch(`/subscriptions/${rc.subscriptionId}`, {
          method: 'PUT',
          body: JSON.stringify({ shopify_variant_id: variantId }),
        });
        result = { success: true, message: `Scent updated to ${params.productTitle || 'new scent'}` };
        break;
      }

      case 'address': {
        const { address1, address2, city, province, zip, country, phone, firstName, lastName } = params;
        if (!address1 || !city || !zip || !country) {
          return res.status(400).json({ error: 'Address, city, ZIP, and country are required' });
        }
        if (!rc.addressId) return res.status(400).json({ error: 'No delivery address on file' });
        await rcFetch(`/addresses/${rc.addressId}`, {
          method: 'PUT',
          body: JSON.stringify({
            address1,
            address2:   address2 || '',
            city,
            province:   province || '',
            zip,
            country,
            phone:      phone || '',
            first_name: firstName || '',
            last_name:  lastName || '',
          }),
        });
        result = { success: true, message: 'Delivery address updated' };
        break;
      }

      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    return res.status(200).json(result);

  } catch (err) {
    console.error('[subscription]', action, err.message);
    return res.status(500).json({ error: err.message || 'Action failed' });
  }
};

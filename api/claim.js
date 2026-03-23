/**
 * Reward Claim Endpoint
 * POST /api/claim
 * Body: { customerId, milestoneId, email, firstName }
 *
 * Marks reward as claimed in Supabase and fires Klaviyo event.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;
const KLAVIYO_KEY  = process.env.KLAVIYO_API_KEY;

const MILESTONES = {
  underwear_v1: { cycles: 5,  label: 'Free Pair of Underwear' },
  tee_v1:       { cycles: 10, label: 'Free Dirty Bastard Tee' },
  legend_pack_v1: { cycles: 20, label: 'The Legend Pack' },
};

module.exports = async function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = ['https://getdirtybastard.com', 'https://dirty-bastard-laundry-co.myshopify.com'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { customerId, milestoneId, email, firstName } = req.body || {};

  if (!customerId || !/^\d+$/.test(String(customerId))) {
    return res.status(400).json({ error: 'Invalid customer id' });
  }
  if (!milestoneId || !MILESTONES[milestoneId]) {
    return res.status(400).json({ error: 'Invalid milestone' });
  }

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(500).json({ error: 'Server configuration error' });
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false },
  });

  try {
    const id = String(customerId);

    // Fetch customer record
    const { data: customer, error: fetchErr } = await supabase
      .from('customer_rewards')
      .select('cycle_count, rewards_earned, rewards_fulfilled')
      .eq('shopify_customer_id', id)
      .single();

    if (fetchErr || !customer) {
      return res.status(404).json({ error: 'No reward record found' });
    }

    const milestone = MILESTONES[milestoneId];

    // Verify they've earned it
    if (customer.cycle_count < milestone.cycles) {
      return res.status(403).json({ error: `Need ${milestone.cycles} cycles to claim this reward` });
    }

    // Check if already claimed
    const fulfilled = customer.rewards_fulfilled || [];
    if (fulfilled.includes(milestoneId)) {
      return res.status(200).json({ success: true, message: 'Already claimed — we\'ll be in touch!' });
    }

    // Mark as fulfilled
    const { error: updateErr } = await supabase
      .from('customer_rewards')
      .update({ rewards_fulfilled: [...fulfilled, milestoneId] })
      .eq('shopify_customer_id', id);

    if (updateErr) throw new Error(updateErr.message);

    // Fire Klaviyo event (non-blocking)
    if (KLAVIYO_KEY && email) {
      fetch('https://a.klaviyo.com/api/events/', {
        method: 'POST',
        headers: {
          'Authorization': `Klaviyo-API-Key ${KLAVIYO_KEY}`,
          'Content-Type': 'application/json',
          'revision': '2023-12-15',
        },
        body: JSON.stringify({
          data: {
            type: 'event',
            attributes: {
              metric: { data: { type: 'metric', attributes: { name: 'Reward Claimed' } } },
              profile: { data: { type: 'profile', attributes: { email } } },
              properties: {
                milestone_id:    milestoneId,
                milestone_label: milestone.label,
                cycles_at_claim: customer.cycle_count,
                customer_id:     id,
                first_name:      firstName || '',
              },
            },
          },
        }),
      }).catch(() => {});
    }

    console.log(`[claim] Customer ${id} claimed ${milestoneId} (${milestone.label})`);

    return res.status(200).json({
      success: true,
      message: `${milestone.label} claimed! We'll reach out to ${email || 'you'} within 48 hours.`,
    });

  } catch (err) {
    console.error('[claim]', err.message);
    return res.status(500).json({ error: 'Claim failed — try again or email hello@getdirtybastard.com' });
  }
};

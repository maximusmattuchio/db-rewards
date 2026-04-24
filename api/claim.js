/**
 * Reward Claim Endpoint
 * POST /api/claim
 * Body: { customerId, milestoneId, email, firstName, size }
 *
 * Marks reward as claimed in Supabase, fires Klaviyo event,
 * and creates a $0 Shopify draft order for fulfillment.
 */

const { createClient } = require('@supabase/supabase-js');

const SUPABASE_URL    = process.env.SUPABASE_URL;
const SUPABASE_KEY    = process.env.SUPABASE_KEY;
const KLAVIYO_KEY     = process.env.KLAVIYO_API_KEY || process.env.KLAYVIO_API_KEY;
const SHOPIFY_TOKEN   = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_SHOP    = process.env.SHOPIFY_SHOP;

// Load milestone config from single source of truth (milestones.js at repo root).
// Any tier rename or cogs change lands here automatically.
const MILESTONES_ARRAY = require('../milestones');
const MILESTONES = MILESTONES_ARRAY.reduce((acc, m) => {
  acc[m.id] = { cycles: m.cycles, label: m.name, emoji: m.emoji, needs_size: m.needs_size };
  return acc;
}, {});

module.exports = async function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = ['https://getdirtybastard.com', 'https://dirty-bastard-laundry-co.myshopify.com'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { customerId, milestoneId, email, firstName, size } = req.body || {};

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

    // Atomic conditional update — only succeeds if milestone not already in array.
    // Prevents race condition where two concurrent requests both pass the check
    // and create two draft orders for the same reward.
    const fulfilled = customer.rewards_fulfilled || [];
    const { data: updated, error: updateErr } = await supabase
      .from('customer_rewards')
      .update({ rewards_fulfilled: [...fulfilled, milestoneId] })
      .eq('shopify_customer_id', id)
      .not('rewards_fulfilled', 'cs', `{"${milestoneId}"}`)
      .select('id');

    if (updateErr) throw new Error(updateErr.message);

    // If 0 rows updated, a concurrent request already claimed it
    if (!updated || updated.length === 0) {
      return res.status(200).json({ success: true, message: 'Already claimed. We will be in touch.' });
    }

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
                size:            size || '',
              },
            },
          },
        }),
      }).catch(() => {});
    }

    // Create Shopify draft order (non-blocking)
    if (SHOPIFY_TOKEN && SHOPIFY_SHOP) {
      const lineItem = {
        title:    milestone.label,
        price:    '0.00',
        quantity: 1,
        requires_shipping: true,
        properties: [
          { name: 'Milestone', value: milestoneId },
          ...(size ? [{ name: 'Size', value: size }] : []),
          { name: 'Cycles at Claim', value: String(customer.cycle_count) },
        ],
      };

      fetch(`https://${SHOPIFY_SHOP}/admin/api/2024-01/draft_orders.json`, {
        method: 'POST',
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_TOKEN,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          draft_order: {
            line_items: [lineItem],
            email,
            note:  `Reward claim: ${milestone.label}${size ? `. Size ${size}` : ''}.`,
            tags:  `reward-claim,${milestoneId}`,
            send_receipt: false,
          },
        }),
      })
      .then(async r => {
        const d = await r.json();
        if (d.draft_order) {
          console.log(`[claim] Draft order #${d.draft_order.id} created for ${email}`);
          // Stash the draft order id + size on reward_events metadata so the Dashboard
          // can link to the Shopify draft and show size on the Ready to Pack queue.
          try {
            await supabase
              .from('reward_events')
              .update({ metadata: { draft_order_id: d.draft_order.id, size: size || null } })
              .eq('shopify_customer_id', id)
              .eq('reward_id', milestoneId)
              .eq('event_type', 'milestone_reached');
          } catch (metaErr) {
            console.error('[claim] metadata update failed:', metaErr.message);
          }
        } else {
          console.error('[claim] Shopify error:', JSON.stringify(d));
        }
      })
      .catch(e => console.error('[claim] Shopify fetch error:', e.message));
    }

    console.log(`[claim] Customer ${id} claimed ${milestoneId} (${milestone.label})`);

    return res.status(200).json({
      success: true,
      message: `${milestone.label} claimed.${size ? ` Size ${size} noted.` : ''} We will reach out to ${email || 'you'} within 48 hours.`,
    });

  } catch (err) {
    console.error('[claim]', err.message);
    return res.status(500).json({ error: 'Claim failed. Try again or email hello@getdirtybastard.com.' });
  }
};

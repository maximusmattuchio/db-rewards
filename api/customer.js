/**
 * Customer Rewards Read Endpoint
 * GET /api/customer?id=SHOPIFY_CUSTOMER_ID
 *
 * Returns cycle count + earned rewards for a given customer.
 * Called client-side from the Bastard Club page.
 */

const { getCycleCount } = require('../lib/supabase');
const MILESTONES = require('../milestones');

module.exports = async function handler(req, res) {
  // CORS — allow requests from your store
  res.setHeader('Access-Control-Allow-Origin', 'https://getdirtybastard.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const customerId = req.query.id;
  if (!customerId) {
    return res.status(400).json({ error: 'Missing customer id' });
  }

  try {
    const data = await getCycleCount(customerId);

    if (!data) {
      // Customer not yet in rewards DB (no subscription charges yet)
      return res.status(200).json({
        found: false,
        cycle_count: 0,
        rewards_earned: [],
        next_milestone: MILESTONES[0],
        cycles_to_next: MILESTONES[0].cycles,
      });
    }

    const { cycle_count, rewards_earned, rewards_fulfilled } = data;

    // Find next milestone
    const next = MILESTONES.find(m => cycle_count < m.cycles) || null;
    const cyclesToNext = next ? next.cycles - cycle_count : 0;

    return res.status(200).json({
      found: true,
      cycle_count,
      rewards_earned: rewards_earned || [],
      rewards_fulfilled: rewards_fulfilled || [],
      milestones: MILESTONES.map(m => ({
        ...m,
        earned: (rewards_earned || []).includes(m.id),
        fulfilled: (rewards_fulfilled || []).includes(m.id),
        progress: Math.min(cycle_count, m.cycles),
      })),
      next_milestone: next,
      cycles_to_next: cyclesToNext,
    });

  } catch (err) {
    console.error('[customer] Error:', err.message);
    return res.status(500).json({ error: 'Failed to load rewards data' });
  }
};

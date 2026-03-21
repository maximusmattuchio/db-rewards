/**
 * Customer Rewards Read Endpoint
 * GET /api/customer?id=SHOPIFY_CUSTOMER_ID
 *
 * Returns cycle count + earned rewards for a given customer.
 * Called client-side from the Bastard Club page.
 * Edge-cached for 60 seconds to reduce DB load at scale.
 */

const { getCycleCount } = require('../lib/supabase');
const MILESTONES = require('../milestones');

module.exports = async function handler(req, res) {
  // CORS — allow requests from the storefront
  res.setHeader('Access-Control-Allow-Origin', 'https://getdirtybastard.com');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  // Edge cache — 60 second TTL reduces DB load significantly at scale
  // Customer sees data that's at most 60s stale, which is acceptable
  res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const customerId = req.query.id;
  if (!customerId || !/^\d+$/.test(customerId)) {
    return res.status(400).json({ error: 'Invalid customer id' });
  }

  try {
    const data = await getCycleCount(customerId);

    if (!data) {
      // Customer not yet in rewards DB — no subscription charges processed yet
      return res.status(200).json({
        found: false,
        cycle_count: 0,
        rewards_earned: [],
        milestones: MILESTONES.map(m => ({
          ...m,
          earned: false,
          fulfilled: false,
          progress: 0,
        })),
        next_milestone: MILESTONES[0],
        cycles_to_next: MILESTONES[0].cycles,
      });
    }

    const { cycle_count, rewards_earned, rewards_fulfilled } = data;

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

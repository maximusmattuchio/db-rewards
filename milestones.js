/**
 * MILESTONE CONFIG
 * Edit this file to change reward thresholds, names, costs, or add new tiers.
 * No other files need to change when updating milestones.
 */

const MILESTONES = [
  {
    id: 'underwear_v1',
    cycles: 3,
    name: 'The Bastard Scent Trio',
    emoji: '🌲',
    description: 'Three cologne-grade car fresheners. One of each scent. So your truck smells like you do.',
    fulfillment: 'manual_email',   // 'manual_email' | 'auto_discount' | 'auto_add_to_order'
    est_cogs: 6.00,
    est_shipping: 1.00,
    needs_size: false,
  },
  {
    id: 'tee_v1',
    cycles: 10,
    name: 'The DB Tee',
    emoji: '👕',
    description: 'Exclusive merch. For the guys who committed.',
    fulfillment: 'manual_email',
    est_cogs: 10.00,
    est_shipping: 2.00,
    needs_size: true,
  },
  {
    id: 'legend_pack_v1',
    cycles: 20,
    name: 'The Legend Sweatshirt',
    emoji: '🧥',
    description: 'Premium DB sweatshirt. Most guys never get here.',
    fulfillment: 'manual_email',
    est_cogs: 16.00,
    est_shipping: 3.00,
    needs_size: true,
  },
];

module.exports = MILESTONES;

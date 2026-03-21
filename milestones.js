/**
 * MILESTONE CONFIG
 * Edit this file to change reward thresholds, names, costs, or add new tiers.
 * No other files need to change when updating milestones.
 */

const MILESTONES = [
  {
    id: 'underwear_v1',
    cycles: 5,
    name: 'Free Pair of Underwear',
    emoji: '🩲',
    description: 'Dirty Bastard branded boxer briefs, on us.',
    fulfillment: 'manual_email',   // 'manual_email' | 'auto_discount' | 'auto_add_to_order'
    est_cogs: 8.00,
    est_shipping: 5.00,
  },
  {
    id: 'tee_v1',
    cycles: 10,
    name: 'Free Dirty Bastard Tee',
    emoji: '👕',
    description: 'Exclusive merch. For the guys who committed.',
    fulfillment: 'manual_email',
    est_cogs: 9.00,
    est_shipping: 5.00,
  },
  {
    id: 'legend_pack_v1',
    cycles: 20,
    name: 'The Legend Pack',
    emoji: '🎁',
    description: 'Full merch drop — tee, hat, mystery gift.',
    fulfillment: 'manual_email',
    est_cogs: 25.00,
    est_shipping: 8.00,
  },
];

module.exports = MILESTONES;

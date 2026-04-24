/**
 * Real-Time AI Customer Scoring
 * GET /api/ai/customer?id=SHOPIFY_CUSTOMER_ID
 *
 * Returns AI churn score + recommended action for a single customer.
 * Cache-or-live strategy:
 *   - If scored within 24h → return cached result immediately (fast, $0 cost)
 *   - If stale or missing → score live with Claude Haiku, cache result
 *
 * Used by the rewards portal and any future dashboard.
 * CORS-restricted to Dirty Bastard domains only.
 */

const { supabase } = require('../../lib/supabase');
const { scoreCustomer, MODEL } = require('../../lib/anthropic');

const CACHE_TTL_HOURS = 24;
const MILESTONES = require('../../milestones');

async function getCachedScore(shopifyCustomerId) {
  const { data } = await supabase
    .from('customer_intelligence')
    .select('*')
    .eq('shopify_customer_id', shopifyCustomerId)
    .single();
  return data || null;
}

async function gatherSignals(shopifyCustomerId) {
  const id = shopifyCustomerId;

  const { data: sub } = await supabase
    .from('recharge_subscriptions_sync')
    .select('status, created_at')
    .eq('shopify_customer_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentCharges } = await supabase
    .from('recharge_charges_sync')
    .select('status')
    .eq('shopify_customer_id', id)
    .gte('created_at', cutoff);

  const charges = recentCharges || [];

  const { data: lastCharge } = await supabase
    .from('recharge_charges_sync')
    .select('status, processed_at')
    .eq('shopify_customer_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  const { data: spendRows } = await supabase
    .from('shopify_orders_sync')
    .select('total_price')
    .eq('shopify_customer_id', id)
    .eq('financial_status', 'paid');

  const totalSpend = (spendRows || []).reduce((sum, o) => sum + Number(o.total_price || 0), 0);

  let subscriptionAgeDays = 0;
  if (sub?.created_at) {
    subscriptionAgeDays = Math.floor((Date.now() - new Date(sub.created_at).getTime()) / 86400000);
  }

  let daysSinceLastCharge = null;
  if (lastCharge?.processed_at) {
    daysSinceLastCharge = Math.floor((Date.now() - new Date(lastCharge.processed_at).getTime()) / 86400000);
  }

  return {
    subscription_status:    sub?.status || 'unknown',
    subscription_age_days:  subscriptionAgeDays,
    recent_failed_charges:  charges.filter(c => c.status === 'failure').length,
    recent_skipped_charges: charges.filter(c => c.status === 'skipped').length,
    total_spend:            totalSpend,
    last_charge_status:     lastCharge?.status || null,
    days_since_last_charge: daysSinceLastCharge,
  };
}

module.exports = async function handler(req, res) {
  const origin  = req.headers.origin || '';
  const allowed = ['https://getdirtybastard.com', 'https://dirty-bastard-laundry-co.myshopify.com'];
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const customerId = req.query.id;
  if (!customerId || !/^\d+$/.test(customerId)) {
    return res.status(400).json({ error: 'Invalid customer id' });
  }

  try {
    // Check cache first
    const cached = await getCachedScore(customerId);
    const cacheThreshold = new Date(Date.now() - CACHE_TTL_HOURS * 60 * 60 * 1000).toISOString();

    if (cached && cached.scored_at && cached.scored_at > cacheThreshold) {
      return res.status(200).json({
        source: 'cache',
        scored_at: cached.scored_at,
        churn_risk_score:           cached.churn_risk_score,
        churn_risk_label:           cached.churn_risk_label,
        churn_risk_factors:         cached.churn_risk_factors,
        recommended_action:         cached.recommended_action,
        recommended_action_reason:  cached.recommended_action_reason,
        predicted_ltv_6mo:          cached.predicted_ltv_6mo,
      });
    }

    // Cache miss or stale — score live
    const { data: rewards } = await supabase
      .from('customer_rewards')
      .select('cycle_count, email')
      .eq('shopify_customer_id', customerId)
      .single();

    const cycleCount = rewards?.cycle_count || 0;
    const next = MILESTONES.find(m => cycleCount < m.cycles) || null;
    const cyclesToNext = next ? next.cycles - cycleCount : 0;

    const signals = await gatherSignals(customerId);
    const scoring = await scoreCustomer({
      shopify_customer_id: customerId,
      cycle_count: cycleCount,
      cycles_to_next_reward: cyclesToNext,
      ...signals,
    });

    const now = new Date().toISOString();
    await supabase
      .from('customer_intelligence')
      .upsert({
        shopify_customer_id:          customerId,
        email:                        rewards?.email || null,
        cycle_count:                  cycleCount,
        subscription_age_days:        signals.subscription_age_days,
        subscription_status:          signals.subscription_status,
        recent_failed_charges:        signals.recent_failed_charges,
        recent_skipped_charges:       signals.recent_skipped_charges,
        total_spend:                  signals.total_spend,
        last_charge_status:           signals.last_charge_status,
        cycles_to_next_reward:        cyclesToNext,
        churn_risk_score:             scoring.churn_risk_score,
        churn_risk_label:             scoring.churn_risk_label,
        churn_risk_factors:           scoring.churn_risk_factors,
        recommended_action:           scoring.recommended_action,
        recommended_action_reason:    scoring.recommended_action_reason,
        predicted_ltv_6mo:            scoring.predicted_ltv_6mo,
        scored_at:                    now,
        score_model:                  MODEL,
        score_version:                '1',
        updated_at:                   now,
      }, { onConflict: 'shopify_customer_id' });

    return res.status(200).json({
      source: 'live',
      scored_at: now,
      churn_risk_score:           scoring.churn_risk_score,
      churn_risk_label:           scoring.churn_risk_label,
      churn_risk_factors:         scoring.churn_risk_factors,
      recommended_action:         scoring.recommended_action,
      recommended_action_reason:  scoring.recommended_action_reason,
      predicted_ltv_6mo:          scoring.predicted_ltv_6mo,
    });

  } catch (err) {
    console.error('[ai/customer] Error:', err.message);
    return res.status(500).json({ error: 'Failed to score customer' });
  }
};

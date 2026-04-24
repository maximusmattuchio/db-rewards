/**
 * Daily Batch AI Scoring
 * GET /api/ai/score
 *
 * Runs daily at 3 AM UTC via Vercel Cron.
 * Fetches all customers from customer_rewards, joins signals from sync tables,
 * scores each with Claude Haiku, upserts results to customer_intelligence.
 *
 * Processes in chunks of 10 to avoid hammering the Anthropic API.
 * Skips customers scored within the last 20 hours (prevents double-runs).
 *
 * Protected by CRON_SECRET.
 */

const { supabase } = require('../../lib/supabase');
const { scoreCustomer, MODEL } = require('../../lib/anthropic');

const CHUNK_SIZE      = 10;
const CHUNK_DELAY_MS  = 1000;   // 1s between chunks
const STALE_HOURS     = 20;     // skip re-scoring if scored more recently than this

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/**
 * Gather all signals for a customer from the sync tables.
 * All queries hit Supabase (local), not external APIs.
 */
async function gatherSignals(shopifyCustomerId) {
  const id = shopifyCustomerId;

  // Subscription
  const { data: sub } = await supabase
    .from('recharge_subscriptions_sync')
    .select('status, created_at, cancelled_at')
    .eq('shopify_customer_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  // Recent charges (last 90 days)
  const cutoff = new Date(Date.now() - 90 * 24 * 60 * 60 * 1000).toISOString();
  const { data: recentCharges } = await supabase
    .from('recharge_charges_sync')
    .select('status, processed_at, updated_at')
    .eq('shopify_customer_id', id)
    .gte('created_at', cutoff)
    .order('created_at', { ascending: false });

  const charges = recentCharges || [];
  const recentFailed  = charges.filter(c => c.status === 'failure').length;
  const recentSkipped = charges.filter(c => c.status === 'skipped').length;

  // Most recent charge overall
  const { data: lastCharge } = await supabase
    .from('recharge_charges_sync')
    .select('status, processed_at')
    .eq('shopify_customer_id', id)
    .order('created_at', { ascending: false })
    .limit(1)
    .single();

  // Lifetime spend
  const { data: spendRow } = await supabase
    .from('shopify_orders_sync')
    .select('total_price')
    .eq('shopify_customer_id', id)
    .eq('financial_status', 'paid');

  const totalSpend = (spendRow || []).reduce((sum, o) => sum + Number(o.total_price || 0), 0);

  // Subscription age
  let subscriptionAgeDays = 0;
  if (sub?.created_at) {
    const created = new Date(sub.created_at);
    subscriptionAgeDays = Math.floor((Date.now() - created.getTime()) / (1000 * 60 * 60 * 24));
  }

  // Days since last charge
  let daysSinceLastCharge = null;
  if (lastCharge?.processed_at) {
    const processed = new Date(lastCharge.processed_at);
    daysSinceLastCharge = Math.floor((Date.now() - processed.getTime()) / (1000 * 60 * 60 * 24));
  }

  return {
    subscription_status:     sub?.status || 'unknown',
    subscription_age_days:   subscriptionAgeDays,
    recent_failed_charges:   recentFailed,
    recent_skipped_charges:  recentSkipped,
    total_spend:             totalSpend,
    last_charge_status:      lastCharge?.status || null,
    days_since_last_charge:  daysSinceLastCharge,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const authHeader = req.headers.authorization;
  const cronSecret = process.env.CRON_SECRET;
  if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const startTime = Date.now();
  const results = { scored: 0, skipped: 0, errors: 0 };

  // Fetch all customers with their current cycle counts
  const { data: customers, error: fetchErr } = await supabase
    .from('customer_rewards')
    .select('shopify_customer_id, email, cycle_count');

  if (fetchErr) {
    return res.status(500).json({ error: `Failed to fetch customers: ${fetchErr.message}` });
  }

  const staleThreshold = new Date(Date.now() - STALE_HOURS * 60 * 60 * 1000).toISOString();

  // Load existing scored_at values to skip recently scored customers
  const { data: existing } = await supabase
    .from('customer_intelligence')
    .select('shopify_customer_id, scored_at');

  const scoredAtMap = {};
  (existing || []).forEach(r => { scoredAtMap[r.shopify_customer_id] = r.scored_at; });

  // Load milestones for cycles_to_next_reward calculation
  const MILESTONES = require('../../milestones');

  console.log(`[ai/score] ${customers.length} customers to evaluate`);

  // Process in chunks
  for (let i = 0; i < customers.length; i += CHUNK_SIZE) {
    const chunk = customers.slice(i, i + CHUNK_SIZE);

    await Promise.all(chunk.map(async (cust) => {
      const { shopify_customer_id, email, cycle_count } = cust;

      // Skip if scored recently
      const scoredAt = scoredAtMap[shopify_customer_id];
      if (scoredAt && scoredAt > staleThreshold) {
        results.skipped++;
        return;
      }

      try {
        const signals = await gatherSignals(shopify_customer_id);

        // Calculate cycles to next reward
        const next = MILESTONES.find(m => cycle_count < m.cycles) || null;
        const cyclesToNext = next ? next.cycles - cycle_count : 0;

        const scoring = await scoreCustomer({
          shopify_customer_id,
          cycle_count,
          cycles_to_next_reward: cyclesToNext,
          ...signals,
        });

        const now = new Date().toISOString();
        const { error: upsertErr } = await supabase
          .from('customer_intelligence')
          .upsert({
            shopify_customer_id,
            email:                    email || null,
            cycle_count,
            subscription_age_days:    signals.subscription_age_days,
            subscription_status:      signals.subscription_status,
            recent_failed_charges:    signals.recent_failed_charges,
            recent_skipped_charges:   signals.recent_skipped_charges,
            total_spend:              signals.total_spend,
            last_charge_status:       signals.last_charge_status,
            last_charge_at:           signals.days_since_last_charge != null
                                        ? new Date(Date.now() - signals.days_since_last_charge * 86400000).toISOString()
                                        : null,
            cycles_to_next_reward:    cyclesToNext,
            churn_risk_score:         scoring.churn_risk_score,
            churn_risk_label:         scoring.churn_risk_label,
            churn_risk_factors:       scoring.churn_risk_factors,
            recommended_action:       scoring.recommended_action,
            recommended_action_reason: scoring.recommended_action_reason,
            predicted_ltv_6mo:        scoring.predicted_ltv_6mo,
            scored_at:                now,
            score_model:              MODEL,
            score_version:            '1',
            updated_at:               now,
          }, { onConflict: 'shopify_customer_id' });

        if (upsertErr) throw new Error(`Upsert failed: ${upsertErr.message}`);
        results.scored++;

      } catch (err) {
        console.error(`[ai/score] Failed for ${shopify_customer_id}:`, err.message);
        results.errors++;
      }
    }));

    if (i + CHUNK_SIZE < customers.length) await sleep(CHUNK_DELAY_MS);
  }

  const duration = Date.now() - startTime;
  console.log(`[ai/score] Done in ${duration}ms — scored:${results.scored} skipped:${results.skipped} errors:${results.errors}`);
  return res.status(200).json({ ...results, duration_ms: duration });
};

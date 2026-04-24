const { createClient } = require('@supabase/supabase-js');

// Fail hard on startup if env vars are missing
const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_KEY;

if (!SUPABASE_URL || !SUPABASE_KEY) {
  throw new Error('SUPABASE_URL and SUPABASE_KEY environment variables must be set');
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: false },
  global: { fetch: (url, opts = {}) => fetch(url, { ...opts, signal: AbortSignal.timeout(8000) }) },
});

// Get customer reward record, create if doesn't exist
// Handles race condition where two concurrent requests try to create the same customer
async function getOrCreateCustomer(shopifyCustomerId, email, rechargeCustomerId) {
  const id = String(shopifyCustomerId);

  const { data: existing } = await supabase
    .from('customer_rewards')
    .select('*')
    .eq('shopify_customer_id', id)
    .single();

  if (existing) return existing;

  const { data: created, error } = await supabase
    .from('customer_rewards')
    .insert({
      shopify_customer_id: id,
      recharge_customer_id: String(rechargeCustomerId || ''),
      email: String(email || '').toLowerCase().trim(),
      cycle_count: 0,
      rewards_earned: [],
      rewards_fulfilled: [],
    })
    .select()
    .single();

  if (error) {
    // Unique constraint violation — customer was created between our select and insert
    if (error.code === '23505') {
      const { data: retry } = await supabase
        .from('customer_rewards')
        .select('*')
        .eq('shopify_customer_id', id)
        .single();
      if (retry) return retry;
    }
    throw new Error(`Failed to create customer: ${error.message}`);
  }

  return created;
}

// Atomic cycle increment using Postgres stored procedure
// Prevents race conditions — this is the ONLY safe way to increment
async function incrementCycles(shopifyCustomerId) {
  const id = String(shopifyCustomerId);
  const { data, error } = await supabase.rpc('increment_cycles', { customer_id: id });
  if (error) throw new Error(`Failed to increment cycles: ${error.message}`);
  return data;
}

// Mark a reward as earned — fully atomic via Postgres stored procedure
// Returns true if newly earned, false if already earned
async function markRewardEarned(shopifyCustomerId, rewardId) {
  const id = String(shopifyCustomerId);
  const { data, error } = await supabase.rpc('append_reward_if_missing', {
    p_customer_id: id,
    p_reward_id: rewardId,
  });
  if (error) throw new Error(`Failed to mark reward: ${error.message}`);
  return data === true;
}

// Get current cycle count and rewards for a customer
async function getCycleCount(shopifyCustomerId) {
  const { data, error } = await supabase
    .from('customer_rewards')
    .select('cycle_count, rewards_earned, rewards_fulfilled')
    .eq('shopify_customer_id', String(shopifyCustomerId))
    .single();

  if (error || !data) return null;
  return data;
}

// Log any event to the audit trail — sanitizes metadata to prevent injection
async function logEvent(shopifyCustomerId, eventType, metadata = {}) {
  const safeMetadata = {
    charge_id: metadata.charge_id ? String(metadata.charge_id).slice(0, 100) : null,
    cycle_count: typeof metadata.cycle_count === 'number' ? metadata.cycle_count : null,
    reward_id: metadata.reward_id ? String(metadata.reward_id).slice(0, 100) : null,
    milestone: typeof metadata.milestone === 'number' ? metadata.milestone : null,
    reason: metadata.reason ? String(metadata.reason).slice(0, 200) : null,
    charge_type: metadata.charge_type ? String(metadata.charge_type).slice(0, 50) : null,
    error: metadata.error ? String(metadata.error).slice(0, 500) : null,
    message: metadata.message ? String(metadata.message).slice(0, 500) : null,
  };

  const { error } = await supabase.from('reward_events').insert({
    shopify_customer_id: String(shopifyCustomerId),
    event_type: String(eventType).slice(0, 50),
    milestone: safeMetadata.milestone,
    reward_id: safeMetadata.reward_id,
    recharge_charge_id: safeMetadata.charge_id,
    metadata: safeMetadata,
  });

  if (error) {
    // Don't throw — logging failure should never crash the webhook
    console.error('[supabase] logEvent failed:', error.message);
  }
}

// Check if a charge has already been processed (idempotency)
async function isProcessed(rechargeChargeId) {
  const { data } = await supabase
    .from('processed_charges')
    .select('recharge_charge_id')
    .eq('recharge_charge_id', String(rechargeChargeId))
    .single();
  return !!data;
}

// Mark a charge as processed — throws on failure so webhook can return 500 and be retried
async function markProcessed(rechargeChargeId) {
  const { error } = await supabase
    .from('processed_charges')
    .insert({ recharge_charge_id: String(rechargeChargeId) });

  if (error && error.code !== '23505') {
    // Ignore duplicate key (already marked) but throw on any other error
    throw new Error(`Failed to mark charge as processed: ${error.message}`);
  }
}

// Delete all reward data for a customer — called on subscription cancellation
// Throws on failure so the caller can decide whether to surface the error
async function deleteCustomerRewards(shopifyCustomerId) {
  const id = String(shopifyCustomerId);
  const { error } = await supabase
    .from('customer_rewards')
    .delete()
    .eq('shopify_customer_id', id);
  if (error) throw new Error(`Failed to delete customer rewards: ${error.message}`);
}

module.exports = {
  supabase,
  getOrCreateCustomer,
  incrementCycles,
  markRewardEarned,
  getCycleCount,
  logEvent,
  isProcessed,
  markProcessed,
  deleteCustomerRewards,
};

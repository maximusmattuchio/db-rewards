const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL || 'https://dxfodfbqqdkuijihfkyf.supabase.co',
  process.env.SUPABASE_KEY
);

// Get customer reward record, create if doesn't exist
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
      email,
      cycle_count: 0,
      rewards_earned: [],
      rewards_fulfilled: [],
    })
    .select()
    .single();

  if (error) throw new Error(`Failed to create customer: ${error.message}`);
  return created;
}

// Increment cycle count
async function incrementCycles(shopifyCustomerId) {
  const id = String(shopifyCustomerId);
  const { data, error } = await supabase.rpc('increment_cycles', { customer_id: id });
  if (error) throw new Error(`Failed to increment cycles: ${error.message}`);
  return data;
}

// Mark a reward as earned
async function markRewardEarned(shopifyCustomerId, rewardId) {
  const id = String(shopifyCustomerId);

  const { data: customer } = await supabase
    .from('customer_rewards')
    .select('rewards_earned')
    .eq('shopify_customer_id', id)
    .single();

  const current = customer?.rewards_earned || [];
  if (current.includes(rewardId)) return false; // already earned

  const { error } = await supabase
    .from('customer_rewards')
    .update({ rewards_earned: [...current, rewardId], updated_at: new Date().toISOString() })
    .eq('shopify_customer_id', id);

  if (error) throw new Error(`Failed to mark reward: ${error.message}`);
  return true;
}

// Get current cycle count
async function getCycleCount(shopifyCustomerId) {
  const { data, error } = await supabase
    .from('customer_rewards')
    .select('cycle_count, rewards_earned, rewards_fulfilled')
    .eq('shopify_customer_id', String(shopifyCustomerId))
    .single();

  if (error || !data) return null;
  return data;
}

// Log any event to the audit trail
async function logEvent(shopifyCustomerId, eventType, metadata = {}) {
  await supabase.from('reward_events').insert({
    shopify_customer_id: String(shopifyCustomerId),
    event_type: eventType,
    milestone: metadata.milestone || null,
    reward_id: metadata.reward_id || null,
    recharge_charge_id: metadata.charge_id || null,
    metadata,
  });
}

// Check if a charge has already been processed
async function isProcessed(rechargeChargeId) {
  const { data } = await supabase
    .from('processed_charges')
    .select('recharge_charge_id')
    .eq('recharge_charge_id', String(rechargeChargeId))
    .single();
  return !!data;
}

// Mark a charge as processed
async function markProcessed(rechargeChargeId) {
  await supabase
    .from('processed_charges')
    .insert({ recharge_charge_id: String(rechargeChargeId) });
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
};

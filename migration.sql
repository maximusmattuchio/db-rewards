-- ─────────────────────────────────────────────────────────────
-- Dirty Bastard Rewards System — Supabase Migration
-- Run this in your Supabase SQL editor
-- ─────────────────────────────────────────────────────────────

-- Source of truth for each customer's reward status
CREATE TABLE IF NOT EXISTS customer_rewards (
  shopify_customer_id TEXT PRIMARY KEY,
  recharge_customer_id TEXT,
  email TEXT NOT NULL,
  cycle_count INTEGER DEFAULT 0,
  rewards_earned TEXT[] DEFAULT '{}',
  rewards_fulfilled TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Full audit log — every event tracked
CREATE TABLE IF NOT EXISTS reward_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_customer_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  -- event_type values:
  --   cycle_counted    — subscription charge processed
  --   milestone_reached — customer hit a milestone
  --   reward_fulfilled  — reward physically sent
  --   webhook_skipped   — charge ignored (one-time, failed, etc)
  --   error             — something went wrong
  milestone INTEGER,
  reward_id TEXT,
  recharge_charge_id TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency table — prevents double-counting duplicate webhooks
CREATE TABLE IF NOT EXISTS processed_charges (
  recharge_charge_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ DEFAULT NOW()
);

-- Index for fast customer lookups in event log
CREATE INDEX IF NOT EXISTS idx_reward_events_customer
  ON reward_events (shopify_customer_id, created_at DESC);

-- Index for milestone queries
CREATE INDEX IF NOT EXISTS idx_reward_events_type
  ON reward_events (event_type, created_at DESC);

-- Stored procedure for safe cycle increment (atomic)
CREATE OR REPLACE FUNCTION increment_cycles(customer_id TEXT)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE customer_rewards
  SET cycle_count = cycle_count + 1, updated_at = NOW()
  WHERE shopify_customer_id = customer_id
  RETURNING cycle_count INTO new_count;
  RETURN new_count;
END;
$$ LANGUAGE plpgsql;

-- ─── ADMIN VIEWS ──────────────────────────────────────────────

-- Easy overview: every customer + their status
CREATE OR REPLACE VIEW rewards_overview AS
SELECT
  cr.shopify_customer_id,
  cr.email,
  cr.cycle_count,
  cr.rewards_earned,
  cr.rewards_fulfilled,
  cr.updated_at,
  CASE
    WHEN cr.cycle_count >= 20 THEN 'Legend'
    WHEN cr.cycle_count >= 10 THEN 'Tier 2'
    WHEN cr.cycle_count >= 5  THEN 'Tier 1'
    ELSE 'Active'
  END AS status
FROM customer_rewards cr
ORDER BY cr.cycle_count DESC;

-- Recent milestone events for fulfillment tracking
CREATE OR REPLACE VIEW pending_fulfillments AS
SELECT
  re.shopify_customer_id,
  cr.email,
  re.reward_id,
  re.milestone,
  re.created_at AS earned_at,
  CASE
    WHEN cr.rewards_fulfilled @> ARRAY[re.reward_id] THEN 'fulfilled'
    ELSE 'pending'
  END AS fulfillment_status
FROM reward_events re
JOIN customer_rewards cr ON cr.shopify_customer_id = re.shopify_customer_id
WHERE re.event_type = 'milestone_reached'
ORDER BY re.created_at DESC;

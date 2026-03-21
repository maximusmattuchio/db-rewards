-- ─────────────────────────────────────────────────────────────
-- Dirty Bastard Rewards System — Supabase Migration v2
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

-- Index for idempotency lookups (already PK, but explicit for clarity)
CREATE INDEX IF NOT EXISTS idx_processed_charges_time
  ON processed_charges (processed_at DESC);

-- ─── STORED PROCEDURES ────────────────────────────────────────

-- Atomic cycle increment — NEVER increment outside this function
-- Uses row-level lock to prevent race conditions
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

-- Atomic array append — only appends if value not already present
-- Prevents duplicate reward entries from race conditions
CREATE OR REPLACE FUNCTION append_reward_if_missing(
  p_customer_id TEXT,
  p_reward_id TEXT
)
RETURNS BOOLEAN AS $$
DECLARE
  updated_count INTEGER;
BEGIN
  UPDATE customer_rewards
  SET
    rewards_earned = array_append(rewards_earned, p_reward_id),
    updated_at = NOW()
  WHERE shopify_customer_id = p_customer_id
    AND NOT (rewards_earned @> ARRAY[p_reward_id]);

  GET DIAGNOSTICS updated_count = ROW_COUNT;
  RETURN updated_count > 0;
END;
$$ LANGUAGE plpgsql;

-- Cleanup job: delete processed_charges older than 180 days
-- Run this monthly via a Supabase cron or manually
CREATE OR REPLACE FUNCTION cleanup_old_charges()
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM processed_charges
  WHERE processed_at < NOW() - INTERVAL '180 days';
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
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
  END AS status,
  CASE
    WHEN cr.cycle_count >= 20 THEN 0
    WHEN cr.cycle_count >= 10 THEN 20 - cr.cycle_count
    WHEN cr.cycle_count >= 5  THEN 10 - cr.cycle_count
    ELSE 5 - cr.cycle_count
  END AS cycles_to_next_reward
FROM customer_rewards cr
ORDER BY cr.cycle_count DESC;

-- Pending fulfillments — rewards earned but not yet physically sent
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
ORDER BY
  CASE WHEN cr.rewards_fulfilled @> ARRAY[re.reward_id] THEN 1 ELSE 0 END ASC,
  re.created_at DESC;

-- Error log view — surface recent failures for debugging
CREATE OR REPLACE VIEW recent_errors AS
SELECT
  re.created_at,
  re.shopify_customer_id,
  cr.email,
  re.metadata->>'error' AS error_type,
  re.metadata->>'message' AS error_message,
  re.recharge_charge_id
FROM reward_events re
LEFT JOIN customer_rewards cr ON cr.shopify_customer_id = re.shopify_customer_id
WHERE re.event_type = 'error'
ORDER BY re.created_at DESC
LIMIT 100;

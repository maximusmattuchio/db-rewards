-- ─────────────────────────────────────────────────────────────────────────────
-- Dirty Bastard Rewards System — Complete Migration
-- Run this in your Supabase SQL editor
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── CORE TABLES ─────────────────────────────────────────────────────────────

-- Source of truth for each customer's reward status
CREATE TABLE IF NOT EXISTS customer_rewards (
  shopify_customer_id  TEXT PRIMARY KEY,
  recharge_customer_id TEXT,
  email                TEXT NOT NULL,
  cycle_count          INTEGER DEFAULT 0,
  rewards_earned       TEXT[] DEFAULT '{}',
  rewards_fulfilled    TEXT[] DEFAULT '{}',
  created_at           TIMESTAMPTZ DEFAULT NOW(),
  updated_at           TIMESTAMPTZ DEFAULT NOW()
);

-- Full audit log — every event tracked forever
CREATE TABLE IF NOT EXISTS reward_events (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_customer_id TEXT NOT NULL,
  event_type          TEXT NOT NULL,
  -- event_type values:
  --   cycle_counted        — subscription charge processed
  --   milestone_reached    — customer hit a milestone
  --   reward_email_sent    — email delivered successfully
  --   reward_fulfilled     — reward physically sent
  --   webhook_skipped      — charge ignored (one-time, failed, etc)
  --   error                — something went wrong
  milestone           INTEGER,
  reward_id           TEXT,
  recharge_charge_id  TEXT,
  metadata            JSONB,
  created_at          TIMESTAMPTZ DEFAULT NOW()
);

-- Idempotency — prevents double-counting duplicate webhooks
CREATE TABLE IF NOT EXISTS processed_charges (
  recharge_charge_id  TEXT PRIMARY KEY,
  processed_at        TIMESTAMPTZ DEFAULT NOW()
);

-- Email queue — async delivery with retry and dead-lettering
CREATE TABLE IF NOT EXISTS queued_emails (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  shopify_customer_id TEXT NOT NULL,
  email               TEXT NOT NULL,
  reward_id           TEXT NOT NULL,
  milestone_id        TEXT NOT NULL,
  cycle_count         INTEGER NOT NULL,
  status              TEXT DEFAULT 'pending', -- pending | failed | sent | dead
  attempt_count       INTEGER DEFAULT 0,
  max_attempts        INTEGER DEFAULT 5,
  last_error          TEXT,
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  next_retry_at       TIMESTAMPTZ DEFAULT NOW(),
  sent_at             TIMESTAMPTZ
);

-- Webhook dead-letter queue — stores failed webhooks for auto-retry
CREATE TABLE IF NOT EXISTS webhook_dlq (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  recharge_charge_id  TEXT,
  raw_body            TEXT NOT NULL,
  topic               TEXT,
  error_message       TEXT,
  attempt_count       INTEGER DEFAULT 1,
  max_attempts        INTEGER DEFAULT 3,
  status              TEXT DEFAULT 'pending', -- pending | resolved | dead
  created_at          TIMESTAMPTZ DEFAULT NOW(),
  next_retry_at       TIMESTAMPTZ DEFAULT NOW() + INTERVAL '1 hour',
  resolved_at         TIMESTAMPTZ
);

-- ─── INDEXES ─────────────────────────────────────────────────────────────────

-- Fast customer lookups in event log
CREATE INDEX IF NOT EXISTS idx_reward_events_customer
  ON reward_events (shopify_customer_id, created_at DESC);

-- Fast event type queries (error monitoring, milestone stats)
CREATE INDEX IF NOT EXISTS idx_reward_events_type
  ON reward_events (event_type, created_at DESC);

-- Fast idempotency lookups
CREATE INDEX IF NOT EXISTS idx_processed_charges_time
  ON processed_charges (processed_at DESC);

-- Email queue: only index actionable rows (pending/failed) for fast cron queries
CREATE INDEX IF NOT EXISTS idx_queued_emails_pending
  ON queued_emails (status, next_retry_at)
  WHERE status IN ('pending', 'failed');

-- Email queue: customer lookup
CREATE INDEX IF NOT EXISTS idx_queued_emails_customer
  ON queued_emails (shopify_customer_id, created_at DESC);

-- DLQ: only index pending for fast cron queries
CREATE INDEX IF NOT EXISTS idx_webhook_dlq_pending
  ON webhook_dlq (status, next_retry_at)
  WHERE status = 'pending';

-- ─── STORED PROCEDURES ───────────────────────────────────────────────────────

-- Atomic cycle increment — the ONLY safe way to increment cycles
-- Uses row-level locking to prevent race conditions at any scale
CREATE OR REPLACE FUNCTION increment_cycles(customer_id TEXT)
RETURNS INTEGER AS $$
DECLARE
  new_count INTEGER;
BEGIN
  UPDATE customer_rewards
  SET cycle_count = cycle_count + 1, updated_at = NOW()
  WHERE shopify_customer_id = customer_id
  RETURNING cycle_count INTO new_count;

  IF new_count IS NULL THEN
    RAISE EXCEPTION 'Customer % not found', customer_id;
  END IF;

  RETURN new_count;
END;
$$ LANGUAGE plpgsql;

-- Atomic reward marking — appends only if reward not already in array
-- Returns TRUE if newly appended, FALSE if already present
CREATE OR REPLACE FUNCTION append_reward_if_missing(
  p_customer_id TEXT,
  p_reward_id   TEXT
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

-- Cleanup: delete processed_charges older than 180 days
-- Called hourly by /api/cron/retry
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

-- ─── ADMIN VIEWS ─────────────────────────────────────────────────────────────

-- Full customer overview with tier and next reward info
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
-- Use this as your fulfillment dashboard
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

-- Recent errors — surface failures for debugging
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

-- Email queue status — at-a-glance delivery health
CREATE OR REPLACE VIEW email_queue_status AS
SELECT
  status,
  COUNT(*) AS count,
  MIN(created_at) AS oldest,
  MAX(next_retry_at) AS next_attempt
FROM queued_emails
GROUP BY status
ORDER BY status;

-- Dead webhook queue — requires manual review
CREATE OR REPLACE VIEW dead_webhooks AS
SELECT
  id,
  recharge_charge_id,
  topic,
  error_message,
  attempt_count,
  created_at
FROM webhook_dlq
WHERE status = 'dead'
ORDER BY created_at DESC;

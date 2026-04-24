-- ============================================================
-- Dirty Bastard Rewards: shipment tracking
-- Adds ops-side shipment state so the Dashboard can track
-- which claimed rewards have physically left HQ.
--
-- Before this: rewards_fulfilled on customer_rewards = "customer clicked claim"
-- After this:  reward_shipments table = "Max packed it and a tracking number exists"
--
-- Apply via Supabase SQL editor or `psql $SUPABASE_URL -f migration_shipments.sql`
-- ============================================================

CREATE TABLE IF NOT EXISTS reward_shipments (
  id                      BIGSERIAL PRIMARY KEY,
  shopify_customer_id     TEXT NOT NULL,
  reward_id               TEXT NOT NULL,
  size                    TEXT,
  tracking_number         TEXT,
  carrier                 TEXT,
  shopify_draft_order_id  BIGINT,
  shopify_order_id        BIGINT,
  shipped_at              TIMESTAMPTZ DEFAULT NOW(),
  shipped_by              TEXT,
  notes                   TEXT,
  created_at              TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (shopify_customer_id, reward_id)
);

CREATE INDEX IF NOT EXISTS idx_reward_shipments_shipped_at
  ON reward_shipments (shipped_at DESC);

CREATE INDEX IF NOT EXISTS idx_reward_shipments_customer
  ON reward_shipments (shopify_customer_id);

-- Rebuild pending_fulfillments with three-state model:
--   ready_to_pack   -> customer claimed, nothing shipped yet. TOP priority for ops.
--   shipped         -> reward_shipments row exists. No action needed.
--   earned_unclaimed-> customer hit the cycle threshold but has not clicked claim.
--                      Usually self-resolves when they visit /pages/rewards.
-- Pulls claimed_size and draft_order_id out of reward_events.metadata JSONB
-- so the Dashboard can show size info before a shipment is recorded.
--
-- DROP first because Postgres CREATE OR REPLACE VIEW refuses to reorder columns.
-- CASCADE drops any dependent views (we recreate fulfillment_sla below).
DROP VIEW IF EXISTS pending_fulfillments CASCADE;

CREATE VIEW pending_fulfillments AS
SELECT
  re.shopify_customer_id,
  cr.email,
  re.reward_id,
  re.milestone,
  re.created_at                                         AS earned_at,
  (re.metadata ->> 'size')                              AS claimed_size,
  ((re.metadata ->> 'draft_order_id')::bigint)          AS claimed_draft_order_id,
  rs.shipped_at                                         AS shipped_at,
  rs.tracking_number                                    AS tracking_number,
  rs.carrier                                            AS carrier,
  rs.size                                               AS shipped_size,
  rs.shopify_draft_order_id                             AS draft_order_id,
  rs.notes                                              AS ship_notes,
  CASE
    WHEN rs.id IS NOT NULL THEN 'shipped'
    WHEN cr.rewards_fulfilled @> ARRAY[re.reward_id] THEN 'ready_to_pack'
    ELSE 'earned_unclaimed'
  END                                                   AS fulfillment_status
FROM reward_events re
JOIN customer_rewards cr
  ON cr.shopify_customer_id = re.shopify_customer_id
LEFT JOIN reward_shipments rs
  ON rs.shopify_customer_id = re.shopify_customer_id
  AND rs.reward_id = re.reward_id
WHERE re.event_type = 'milestone_reached'
ORDER BY
  -- ready_to_pack first (ops must handle), earned_unclaimed next, shipped last
  CASE
    WHEN rs.id IS NULL AND cr.rewards_fulfilled @> ARRAY[re.reward_id] THEN 0
    WHEN rs.id IS NULL                                                 THEN 1
    ELSE 2
  END ASC,
  re.created_at DESC;

-- View for the Dashboard header: one-line ops SLA.
-- Surfaces how many Ready to Pack older than 2 business days (alarm zone).
DROP VIEW IF EXISTS fulfillment_sla;

CREATE VIEW fulfillment_sla AS
SELECT
  COUNT(*) FILTER (WHERE fulfillment_status = 'ready_to_pack')            AS ready_total,
  COUNT(*) FILTER (WHERE fulfillment_status = 'ready_to_pack'
                    AND earned_at < NOW() - INTERVAL '2 days')            AS ready_over_2d,
  COUNT(*) FILTER (WHERE fulfillment_status = 'ready_to_pack'
                    AND earned_at < NOW() - INTERVAL '5 days')            AS ready_over_5d,
  COUNT(*) FILTER (WHERE fulfillment_status = 'shipped'
                    AND shipped_at > NOW() - INTERVAL '7 days')           AS shipped_last_7d
FROM pending_fulfillments;

-- Full reward history per customer (for customer detail drawer, post-MVP)
DROP VIEW IF EXISTS customer_reward_history;

CREATE VIEW customer_reward_history AS
SELECT
  cr.shopify_customer_id,
  cr.email,
  cr.cycle_count,
  cr.rewards_earned,
  cr.rewards_fulfilled,
  COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'reward_id',        rs.reward_id,
        'size',             rs.size,
        'tracking_number',  rs.tracking_number,
        'carrier',          rs.carrier,
        'shipped_at',       rs.shipped_at,
        'notes',            rs.notes
      )
      ORDER BY rs.shipped_at DESC
    ) FILTER (WHERE rs.id IS NOT NULL),
    '[]'::jsonb
  ) AS shipments
FROM customer_rewards cr
LEFT JOIN reward_shipments rs
  ON rs.shopify_customer_id = cr.shopify_customer_id
GROUP BY
  cr.shopify_customer_id,
  cr.email,
  cr.cycle_count,
  cr.rewards_earned,
  cr.rewards_fulfilled;

-- Grants / RLS policies: rely on service-role key for writes (server-only).
-- Public role has no direct access.

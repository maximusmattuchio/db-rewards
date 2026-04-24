-- ─────────────────────────────────────────────────────────────────────────────
-- Dirty Bastard AI Intelligence Layer — Migration
-- Run in Supabase SQL editor AFTER migration.sql
-- ─────────────────────────────────────────────────────────────────────────────

-- ─── SYNC STATE ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sync_state (
  sync_key        TEXT PRIMARY KEY,
  last_synced_at  TIMESTAMPTZ,
  last_run_at     TIMESTAMPTZ,
  records_synced  INTEGER DEFAULT 0,
  error           TEXT,
  updated_at      TIMESTAMPTZ DEFAULT NOW()
);

INSERT INTO sync_state (sync_key) VALUES
  ('shopify_orders'),
  ('recharge_charges'),
  ('recharge_subscriptions')
ON CONFLICT (sync_key) DO NOTHING;

-- ─── SHOPIFY ORDERS SYNC ─────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shopify_orders_sync (
  shopify_order_id      TEXT PRIMARY KEY,
  shopify_customer_id   TEXT NOT NULL,
  email                 TEXT,
  financial_status      TEXT,
  fulfillment_status    TEXT,
  total_price           NUMERIC(10,2),
  currency              TEXT DEFAULT 'USD',
  order_number          INTEGER,
  tags                  TEXT,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  synced_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer
  ON shopify_orders_sync (shopify_customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shopify_orders_updated
  ON shopify_orders_sync (updated_at DESC);

-- ─── RECHARGE CHARGES SYNC ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recharge_charges_sync (
  recharge_charge_id    TEXT PRIMARY KEY,
  recharge_customer_id  TEXT NOT NULL,
  shopify_customer_id   TEXT,
  email                 TEXT,
  status                TEXT,
  amount                NUMERIC(10,2),
  currency              TEXT DEFAULT 'USD',
  scheduled_at          TIMESTAMPTZ,
  processed_at          TIMESTAMPTZ,
  error_type            TEXT,
  created_at            TIMESTAMPTZ,
  updated_at            TIMESTAMPTZ,
  synced_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recharge_charges_customer
  ON recharge_charges_sync (shopify_customer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_charges_status
  ON recharge_charges_sync (shopify_customer_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_recharge_charges_updated
  ON recharge_charges_sync (updated_at DESC);

-- ─── RECHARGE SUBSCRIPTIONS SYNC ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS recharge_subscriptions_sync (
  recharge_subscription_id  TEXT PRIMARY KEY,
  recharge_customer_id      TEXT NOT NULL,
  shopify_customer_id       TEXT,
  email                     TEXT,
  status                    TEXT,
  product_title             TEXT,
  variant_title             TEXT,
  price                     NUMERIC(10,2),
  order_interval_frequency  INTEGER,
  order_interval_unit       TEXT,
  cancellation_reason       TEXT,
  cancellation_reason_comments TEXT,
  cancelled_at              TIMESTAMPTZ,
  created_at                TIMESTAMPTZ,
  updated_at                TIMESTAMPTZ,
  synced_at                 TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_recharge_subs_customer
  ON recharge_subscriptions_sync (shopify_customer_id, status);
CREATE INDEX IF NOT EXISTS idx_recharge_subs_updated
  ON recharge_subscriptions_sync (updated_at DESC);

-- ─── CUSTOMER INTELLIGENCE ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS customer_intelligence (
  shopify_customer_id       TEXT PRIMARY KEY,
  email                     TEXT,
  -- Raw signals stored for debugging + model improvement
  cycle_count               INTEGER,
  subscription_age_days     INTEGER,
  subscription_status       TEXT,
  recent_failed_charges     INTEGER,
  recent_skipped_charges    INTEGER,
  total_spend               NUMERIC(10,2),
  last_charge_status        TEXT,
  last_charge_at            TIMESTAMPTZ,
  cycles_to_next_reward     INTEGER,
  -- AI outputs
  churn_risk_score          NUMERIC(4,3),
  churn_risk_label          TEXT,
  churn_risk_factors        TEXT[],
  recommended_action        TEXT,
  recommended_action_reason TEXT,
  predicted_ltv_6mo         NUMERIC(10,2),
  -- Metadata
  scored_at                 TIMESTAMPTZ,
  score_model               TEXT DEFAULT 'claude-haiku-4',
  score_version             TEXT DEFAULT '1',
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_intelligence_risk
  ON customer_intelligence (churn_risk_label, scored_at DESC);
CREATE INDEX IF NOT EXISTS idx_customer_intelligence_action
  ON customer_intelligence (recommended_action, scored_at DESC);

-- ─── UNIFIED VIEW (analytics/dashboard only — never call from API) ────────────
CREATE OR REPLACE VIEW customers_unified AS
SELECT
  cr.shopify_customer_id,
  cr.email,
  cr.cycle_count,
  cr.rewards_earned,
  cr.rewards_fulfilled,
  cr.updated_at                AS rewards_updated_at,

  rss.status                   AS subscription_status,
  rss.product_title            AS subscription_product,
  rss.order_interval_frequency,
  rss.order_interval_unit,
  rss.created_at               AS subscription_started_at,
  rss.cancelled_at,
  rss.cancellation_reason,

  ord_agg.total_orders,
  ord_agg.total_spend,
  ord_agg.last_order_at,

  chg_agg.recent_failed_charges,
  chg_agg.recent_skipped_charges,

  ci.churn_risk_score,
  ci.churn_risk_label,
  ci.churn_risk_factors,
  ci.recommended_action,
  ci.recommended_action_reason,
  ci.predicted_ltv_6mo,
  ci.scored_at

FROM customer_rewards cr

LEFT JOIN LATERAL (
  SELECT * FROM recharge_subscriptions_sync s
  WHERE s.shopify_customer_id = cr.shopify_customer_id
  ORDER BY s.created_at DESC
  LIMIT 1
) rss ON TRUE

LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE financial_status = 'paid')         AS total_orders,
    COALESCE(SUM(total_price) FILTER (WHERE financial_status = 'paid'), 0) AS total_spend,
    MAX(created_at)                                            AS last_order_at
  FROM shopify_orders_sync o
  WHERE o.shopify_customer_id = cr.shopify_customer_id
) ord_agg ON TRUE

LEFT JOIN LATERAL (
  SELECT
    COUNT(*) FILTER (WHERE status = 'failure' AND created_at > NOW() - INTERVAL '90 days') AS recent_failed_charges,
    COUNT(*) FILTER (WHERE status = 'skipped' AND created_at > NOW() - INTERVAL '90 days') AS recent_skipped_charges
  FROM recharge_charges_sync c
  WHERE c.shopify_customer_id = cr.shopify_customer_id
) chg_agg ON TRUE

LEFT JOIN customer_intelligence ci
  ON ci.shopify_customer_id = cr.shopify_customer_id

ORDER BY cr.cycle_count DESC;

-- 166_ai_gateway_governance.sql
--
-- AI gateway governance + cost attribution.
--
--   * workspace_ai_policy, per-workspace routing policy (max model tier,
--     provider override, monthly budget). Lets an admin pin "support team
--     -> cheap, finance -> premium" as a CFO-visible cost lever. A policy
--     can only RESTRICT (clamp tier down), never escalate.
--   * v_ai_cost_daily, chargeback aggregation over the existing
--     `ai.completion` analytics events. No new write path: the gateway
--     already emits cost_usd + tokens per call; this view turns that
--     stream into per-workspace / per-feature / per-day spend so the
--     "AI cost-efficiency" positioning becomes a measurable dashboard.
--
-- Idempotent. Paired rollback in 166_ai_gateway_governance.down.sql.

CREATE TABLE IF NOT EXISTS workspace_ai_policy (
  workspace_id        TEXT PRIMARY KEY,
  max_tier            TEXT,
  provider_override   TEXT,
  monthly_budget_usd  NUMERIC,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT workspace_ai_policy_max_tier_chk
    CHECK (max_tier IS NULL OR max_tier IN ('cheap', 'standard', 'premium')),
  CONSTRAINT workspace_ai_policy_provider_chk
    CHECK (provider_override IS NULL OR provider_override IN ('anthropic', 'azure-openai')),
  CONSTRAINT workspace_ai_policy_budget_chk
    CHECK (monthly_budget_usd IS NULL OR monthly_budget_usd >= 0)
);

-- RLS on (matches the repo bar; isolation is enforced app-side by an
-- explicit workspace_id predicate, consistent with sibling tables).
ALTER TABLE workspace_ai_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_ai_policy_all ON workspace_ai_policy;
CREATE POLICY workspace_ai_policy_all ON workspace_ai_policy
  FOR ALL USING (true) WITH CHECK (true);

-- Chargeback view: one row per (day, workspace, feature, provider, model,
-- user). Reads the append-only ai.completion event stream, nothing to
-- backfill. `semantic_hit` / `cache_hit` let the dashboard show savings.
CREATE OR REPLACE VIEW v_ai_cost_daily AS
SELECT
  date_trunc('day', timestamp)::date              AS day,
  COALESCE(metadata->>'workspace_id', 'default')  AS workspace_id,
  COALESCE(metadata->>'feature', 'unknown')       AS feature,
  COALESCE(metadata->>'provider', 'unknown')      AS provider,
  COALESCE(metadata->>'model', 'unknown')         AS model,
  user_id,
  COUNT(*)                                                       AS calls,
  COALESCE(SUM(NULLIF(metadata->>'cost_usd', '')::numeric), 0)   AS cost_usd,
  COALESCE(SUM(NULLIF(metadata->>'input_tokens', '')::numeric), 0)  AS input_tokens,
  COALESCE(SUM(NULLIF(metadata->>'output_tokens', '')::numeric), 0) AS output_tokens,
  SUM(CASE WHEN metadata->>'fallback_used' = 'true' THEN 1 ELSE 0 END) AS fallbacks,
  SUM(CASE WHEN metadata->>'semantic_hit' = 'true' THEN 1 ELSE 0 END)  AS semantic_hits
FROM instinct_events
WHERE event_type = 'ai.completion'
GROUP BY 1, 2, 3, 4, 5, 6;

-- 205_cross_scan_insights.sql
--
-- CROSS-SCAN INSIGHTS ledger - the durable home of the moat.
--
-- The cross-scan engine (src/lib/platform-scan/insights/correlate.ts +
-- generate.ts) reads the WHOLE finding corpus across every modality (frontend /
-- backend / db / security / ux / perf) AND across time (resolved->reopened) and
-- folds it into higher-order Insights no single-layer scanner can produce:
-- compound_risk, regression, systemic_pattern, coverage_blind_spot. Until now
-- those insights existed only as analytics events fired in the moment; nothing
-- persisted, so the cross-scan FEED and the dedup-across-runs were impossible.
-- This table is the per-insight record: one row per logical insight, keyed by a
-- stable dedup `key` so re-runs UPSERT instead of piling up. No data lost: every
-- insight the engine ever produced is durable here, complementing the analytics.
--
-- Schema guard: id is TEXT (opaque "xins_<key>"), NOT UUID, to match the
-- platform-scan family (migrations 192 / 193 / 197 / 198 / 203 and the
-- schema-guard tests). A UUID column would 500 on every real write.
--
-- modalities + members are JSONB (the modality set + the member finding refs).
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded indexes. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 203 / 196.
-- A UNIQUE index on `key` is the dedup guard the store's ON CONFLICT (key) needs.
-- Paired 205_cross_scan_insights.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_cross_scan_insights (
  id            TEXT         PRIMARY KEY,
  generated_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- The target/platform this insight is about ("all" for a systemic pattern that
  -- spans many targets).
  platform      TEXT         NOT NULL DEFAULT '',
  -- One of: compound_risk | regression | systemic_pattern | coverage_blind_spot.
  kind          TEXT         NOT NULL,
  -- Elevated/peak severity of the insight (critical|high|medium|low).
  severity      TEXT         NOT NULL,
  -- Distinct categories/modalities the insight spans.
  modalities    JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- The member finding refs that compose the insight (empty for a blind spot).
  members       JSONB        NOT NULL DEFAULT '[]'::jsonb,
  -- Human-readable explanation of the chain / pattern / regression.
  narrative     TEXT         NOT NULL DEFAULT '',
  -- Review status; open until a human triages it.
  status        TEXT         NOT NULL DEFAULT 'open',
  -- Stable dedup key: same logical insight -> same key across re-runs.
  key           TEXT         NOT NULL
);

-- Dedup guard: ON CONFLICT (key) in the store needs a UNIQUE constraint on key,
-- so a re-run UPSERTS the same logical insight rather than inserting a duplicate.
CREATE UNIQUE INDEX IF NOT EXISTS idx_cross_scan_insights_key
  ON instinct_cross_scan_insights (key);

-- Hot lookup: the dashboard feed reads recent insights newest-first.
CREATE INDEX IF NOT EXISTS idx_cross_scan_insights_generated_at
  ON instinct_cross_scan_insights (generated_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 203.
ALTER TABLE instinct_cross_scan_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_cross_scan_insights_all ON instinct_cross_scan_insights;
CREATE POLICY instinct_cross_scan_insights_all ON instinct_cross_scan_insights
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_cross_scan_insights'
       AND column_name IN ('id','generated_at','platform','kind','severity',
                           'modalities','members','narrative','status','key')
  ) = 10, 'instinct_cross_scan_insights missing expected columns';

  -- Schema-guard parity: id must be TEXT, never UUID.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_cross_scan_insights' AND column_name = 'id'
  ) = 'text', 'instinct_cross_scan_insights.id must be TEXT';

  -- modalities + members must be JSONB.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_cross_scan_insights' AND column_name = 'modalities'
  ) = 'jsonb', 'instinct_cross_scan_insights.modalities must be JSONB';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_cross_scan_insights' AND column_name = 'members'
  ) = 'jsonb', 'instinct_cross_scan_insights.members must be JSONB';

  -- RLS must be ON - a silent NOOP would defeat the tripwire.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_cross_scan_insights'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_cross_scan_insights - aborting migration 205.';
  END IF;
END $$;

COMMIT;

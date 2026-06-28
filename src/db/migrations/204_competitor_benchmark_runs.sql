-- 204_competitor_benchmark_runs.sql
--
-- THE COMPETITIVE BENCHMARK ledger. The competitive scorer
-- (src/lib/platform-scan/benchmark/competitive.ts) runs a third-party free
-- scanner (OWASP ZAP, Nuclei) against the SAME consent-to-test corpus +
-- per-target GROUND TRUTH as us, scores it with the SAME scorer, and lays the
-- result next to our own recall/precision. This table is the per-(tool,target)
-- record that makes the head-to-head native + trended: one row per competitor
-- scoring run, with the headline metrics broken out (for the comparison bars) AND
-- the full head-to-head report as JSONB (rival-only gaps, parity, our side). No
-- data lost: every competitor run + every detected gap is durable here.
--
-- Schema guard: id is TEXT (opaque generated id like "comp_<uuid>"), NOT UUID, to
-- match the platform-scan family (migrations 192 / 193 / 197 / 198 / 203 and the
-- schema-guard tests). A UUID column would 500 on every real write.
--
-- recall / precision are NUMERIC (0..1 ratios). findings is an INTEGER tally.
-- report JSONB carries the full CompetitiveReport so a client-facing comparison
-- can be reconstructed without re-running the scorer.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 203 / 196.
-- Paired 204_competitor_benchmark_runs.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_competitor_benchmark_runs (
  id        TEXT         PRIMARY KEY,
  run_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- The competitor tool ("zap" | "nuclei" | future).
  tool      TEXT         NOT NULL,
  -- The corpus target name the tool was scored against.
  target    TEXT         NOT NULL,
  -- The competitor's recall over the target's ground truth (0..1).
  recall    NUMERIC      NOT NULL DEFAULT 0,
  -- The competitor's precision over the target's ground truth (0..1).
  precision NUMERIC      NOT NULL DEFAULT 0,
  -- How many normalized findings the tool produced for this target.
  findings  INTEGER      NOT NULL DEFAULT 0,
  -- Full CompetitiveReport (per-tool head-to-head, rivalOnlyGaps, parity, ours).
  report    JSONB        NOT NULL DEFAULT '{}'::jsonb
);

-- Hot lookup: the dashboard comparison reads recent runs newest-first.
CREATE INDEX IF NOT EXISTS idx_competitor_runs_run_at
  ON instinct_competitor_benchmark_runs (run_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 203.
ALTER TABLE instinct_competitor_benchmark_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_competitor_benchmark_runs_all ON instinct_competitor_benchmark_runs;
CREATE POLICY instinct_competitor_benchmark_runs_all ON instinct_competitor_benchmark_runs
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_competitor_benchmark_runs'
       AND column_name IN ('id','run_at','tool','target','recall',
                           'precision','findings','report')
  ) = 8, 'instinct_competitor_benchmark_runs missing expected columns';

  -- Schema-guard parity: id must be TEXT, never UUID.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_competitor_benchmark_runs' AND column_name = 'id'
  ) = 'text', 'instinct_competitor_benchmark_runs.id must be TEXT';

  -- report must be JSONB.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_competitor_benchmark_runs' AND column_name = 'report'
  ) = 'jsonb', 'instinct_competitor_benchmark_runs.report must be JSONB';

  -- RLS must be ON - a silent NOOP would defeat the tripwire.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_competitor_benchmark_runs'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_competitor_benchmark_runs - aborting migration 204.';
  END IF;
END $$;

COMMIT;

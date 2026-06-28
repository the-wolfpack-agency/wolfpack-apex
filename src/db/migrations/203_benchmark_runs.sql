-- 203_benchmark_runs.sql
--
-- ACTIVE-LEARNING BENCHMARK ledger. The benchmark scorer
-- (src/lib/platform-scan/benchmark/scorer.ts) runs the scanner's INGESTED
-- findings against the consent-to-test corpus's per-target GROUND TRUTH and
-- mines two kinds of "improve the tool" learning signals (coverage_gap +
-- noise_candidate). Until now the score + signals existed only as analytics
-- events fired in the moment; nothing persisted, so the precision/recall TREND
-- and the live signal BACKLOG were invisible. This table is the per-run record
-- that makes the active-learning loop native + trended in apex: one row per
-- scoring run, with the headline metrics broken out (for the trend chart) AND
-- the full report + signals as JSONB (for drill-down / the gap backlog). No data
-- lost: every benchmark run and every mined signal is durable here.
--
-- Schema guard: id is TEXT (opaque generated id like "bench_<uuid>"), NOT UUID,
-- to match the platform-scan family (migrations 192 / 193 / 197 / 198 and the
-- user-id / workspace-id schema-guard tests). A UUID column would 500 on every
-- real write.
--
-- Metric columns are NUMERIC (recall / precision are 0..1 ratios). targets /
-- labeled_targets / coverage_classes / errored are INTEGER tallies. report +
-- signals JSONB carry the full BenchmarkReport and LearningSignal[] so a future
-- detector author can read exactly which classes were missed / noisy on each run
-- without re-running the scorer.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring the sibling
-- platform-scan tables (migration 196). Paired 203_benchmark_runs.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_benchmark_runs (
  id               TEXT         PRIMARY KEY,
  run_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Total targets evaluated (including errored ones).
  targets          INTEGER      NOT NULL DEFAULT 0,
  -- How many of those carried ground truth. recall/precision are only
  -- trustworthy when this is > 0 (the precision-first honesty caveat).
  labeled_targets  INTEGER      NOT NULL DEFAULT 0,
  -- Overall recall over LABELED targets only (0..1).
  recall           NUMERIC      NOT NULL DEFAULT 1,
  -- Precision-ish over LABELED targets only (0..1).
  precision        NUMERIC      NOT NULL DEFAULT 1,
  -- Distinct finding classes seen across ALL targets (coverage breadth).
  coverage_classes INTEGER      NOT NULL DEFAULT 0,
  -- Targets that errored (could not be scored) - a robustness signal.
  errored          INTEGER      NOT NULL DEFAULT 0,
  -- Full BenchmarkReport (perTarget scores, etc.) for drill-down.
  report           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Mined LearningSignal[] (coverage_gap + noise_candidate) - the backlog.
  signals          JSONB        NOT NULL DEFAULT '[]'::jsonb
);

-- Hot lookup: the dashboard trend reads recent runs newest-first.
CREATE INDEX IF NOT EXISTS idx_benchmark_runs_run_at
  ON instinct_benchmark_runs (run_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 196.
ALTER TABLE instinct_benchmark_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_benchmark_runs_all ON instinct_benchmark_runs;
CREATE POLICY instinct_benchmark_runs_all ON instinct_benchmark_runs
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_benchmark_runs'
       AND column_name IN ('id','run_at','targets','labeled_targets','recall',
                           'precision','coverage_classes','errored','report','signals')
  ) = 10, 'instinct_benchmark_runs missing expected columns';

  -- Schema-guard parity: id must be TEXT, never UUID.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_benchmark_runs' AND column_name = 'id'
  ) = 'text', 'instinct_benchmark_runs.id must be TEXT';

  -- report + signals must be JSONB.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_benchmark_runs' AND column_name = 'report'
  ) = 'jsonb', 'instinct_benchmark_runs.report must be JSONB';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_benchmark_runs' AND column_name = 'signals'
  ) = 'jsonb', 'instinct_benchmark_runs.signals must be JSONB';

  -- RLS must be ON - a silent NOOP would defeat the tripwire.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_benchmark_runs'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_benchmark_runs - aborting migration 203.';
  END IF;
END $$;

COMMIT;

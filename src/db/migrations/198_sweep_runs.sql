-- 198_sweep_runs.sql
--
-- Continuous-sweep OBSERVABILITY ledger. The two cron sweeps
-- (engagement-sweep, pentest-sweep) keep a client's security posture fresh by
-- re-running scans on a schedule. Until now a broken sweep was INVISIBLE: the
-- route caught the error and returned a zeroed 200 so the cron monitor stayed
-- green, while the client's posture quietly went stale with NO alert. This table
-- is the per-run health record that makes a broken sweep visible: one row per
-- sweep tick, with the per-target tally and the derived status. No data lost
-- about sweep health.
--
-- Status semantics (decided in src/lib/platform-scan/sweep-health.ts):
--   ok      -> every target that was attempted succeeded (failures = 0)
--   partial -> at least one target failed AND at least one succeeded
--   failed  -> every attempted target failed, OR the sweep itself threw before
--              it could attempt any target (orchestrator-level throw)
-- A partial or failed run fires platform.sweep_failed + alerts the operator via
-- the existing notifications layer; an ok run fires platform.sweep_completed.
--
-- details JSONB carries the per-target outcomes ([{ target, ok, reason? }, ...])
-- so one failing target never silently vanishes - the reason is queryable here
-- even though the cron still returns 200.
--
-- Schema guard: id is TEXT (opaque generated id like "swp_<rand>"), NOT UUID, to
-- match the platform-scan family (migrations 192 / 193 / 197 and the user-id /
-- workspace-id schema-guard tests). A UUID column would 500 on every real write.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. Paired .down.sql drops
-- the table.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_sweep_runs (
  id                TEXT         PRIMARY KEY,
  -- 'engagement' | 'pentest' - which cron sweep produced this run.
  kind              TEXT         NOT NULL,
  started_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  finished_at       TIMESTAMPTZ,
  targets_total     INTEGER      NOT NULL DEFAULT 0,
  targets_succeeded INTEGER      NOT NULL DEFAULT 0,
  targets_failed    INTEGER      NOT NULL DEFAULT 0,
  -- 'ok' | 'partial' | 'failed' - derived health of this run.
  status            TEXT         NOT NULL,
  -- Top-level error message when the sweep itself threw (orchestrator-level
  -- failure). NULL on ok / partial runs where targets ran but some failed.
  error             TEXT,
  -- Per-target outcomes: [{ "target": "...", "ok": false, "reason": "error:..." }]
  -- plus run aggregates. The queryable record of exactly what failed and why.
  details           JSONB        NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT instinct_sweep_runs_kind_chk   CHECK (kind   IN ('engagement', 'pentest')),
  CONSTRAINT instinct_sweep_runs_status_chk CHECK (status IN ('ok', 'partial', 'failed'))
);

-- Hot lookups: "latest run for this kind" (dedup decision + health page) and
-- "recent unhealthy runs" both order by kind + started_at DESC.
CREATE INDEX IF NOT EXISTS idx_sweep_runs_kind_started
  ON instinct_sweep_runs (kind, started_at DESC);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_sweep_runs'
       AND column_name IN ('id','kind','started_at','finished_at','targets_total',
                           'targets_succeeded','targets_failed','status','error','details')
  ) = 10, 'instinct_sweep_runs missing expected columns';

  -- Schema-guard parity: id and kind must be TEXT, never UUID.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_sweep_runs' AND column_name = 'id'
  ) = 'text', 'instinct_sweep_runs.id must be TEXT';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_sweep_runs' AND column_name = 'kind'
  ) = 'text', 'instinct_sweep_runs.kind must be TEXT';
END $$;

COMMIT;

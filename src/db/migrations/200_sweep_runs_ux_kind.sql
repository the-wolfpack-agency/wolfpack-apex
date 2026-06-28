-- Migration 200 - widen instinct_sweep_runs.kind to include 'ux'.
--
-- Why this exists: the tier-1 browser UX scan (scripts/ux-scan.mjs, run from a
-- scheduled GitHub Actions workflow because it needs a real chromium the Vercel
-- cron cannot run) is becoming a CONTINUOUS sweep, exactly like the engagement
-- and pentest cron sweeps. Its run health belongs in the SAME health ledger
-- (instinct_sweep_runs, migration 198) so a broken UX sweep is just as visible:
-- one row per tick, derived status, status-change-deduped alerting. Re-runs that
-- find a previously-flagged issue fixed naturally resolve it, because the ingest
-- route classifies + recordScan re-evaluates findings on every pass.
--
-- The 198 table pinned kind to ('engagement','pentest') via a named CHECK. To
-- record a 'ux' run in the same ledger, that CHECK must be widened. We drop +
-- re-add the named constraint idempotently (mirrors how 182 / 199 widened the
-- connector auth_type CHECK), so a re-run is safe.
--
-- No new columns: a UX sweep run is shape-identical to the others (per-target
-- tally + details JSONB). The .down.sql restores the 2-value set.

BEGIN;

ALTER TABLE instinct_sweep_runs
  DROP CONSTRAINT IF EXISTS instinct_sweep_runs_kind_chk;

ALTER TABLE instinct_sweep_runs
  ADD CONSTRAINT instinct_sweep_runs_kind_chk
  CHECK (kind IN ('engagement', 'pentest', 'ux'));

COMMENT ON COLUMN instinct_sweep_runs.kind IS
  'Which continuous sweep produced this run: engagement | pentest | ux. The ux kind is the tier-1 browser UX/a11y scan run from the scheduled GitHub Actions workflow (ux-scan-sweep.yml).';

COMMIT;

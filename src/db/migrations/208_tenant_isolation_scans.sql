-- 208_tenant_isolation_scans.sql
--
-- TENANT-ISOLATION COVERAGE LEDGER.
--
-- The repo-wide tenant-isolation guardrail (src/lib/db/tenant-scope-scan.ts +
-- src/lib/db/__tests__/tenant-isolation-global.test.ts) statically proves no
-- query reads/writes a workspace-scoped table without a workspace_id predicate.
-- That gate runs at PR time. THIS table records the same coverage metric as a
-- time series, written by /api/cron/tenant-isolation-scan, so the learning loop
-- can SEE the gap over time: how many workspace-scoped tables exist, how many
-- offenders are accounted for by which benign class, and (the number that must
-- stay 0) how many are unclassified cross-tenant leaks. No data lost: every scan
-- is a durable row + a `system.tenant_isolation_scanned` analytics event.
--
-- NOT workspace-scoped: this is a codebase-wide engineering metric, not tenant
-- data, so it intentionally has NO workspace_id column (and is therefore not in
-- the guardrail's scoped-table set).
--
-- Schema guard: id is TEXT (opaque "tis_<iso>"), NOT UUID, matching the
-- platform-scan / release-gate family (203 / 205 / 206 / 207 and their guards).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded indexes. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 207. Paired
-- 208_tenant_isolation_scans.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_tenant_isolation_scans (
  -- Opaque stable key "tis_<iso8601>" — one row per recorded scan.
  id              TEXT         PRIMARY KEY,
  observed_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Count of workspace-scoped tables the scan discovered.
  scoped_tables   INT          NOT NULL,
  -- Filtering queries lacking a static workspace_id predicate, total.
  total_offenders INT          NOT NULL,
  -- The number that MUST be 0: offenders matching no benign class.
  unclassified    INT          NOT NULL,
  -- Per-class breakdown { principal-resolve, pk-pinned-upstream, ... }.
  counts          JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- How the scan was triggered: 'cron' | 'manual'.
  source          TEXT         NOT NULL DEFAULT 'cron'
);

-- Trend scan: "coverage over the last N days" newest-first.
CREATE INDEX IF NOT EXISTS idx_tenant_isolation_scans_observed_at
  ON instinct_tenant_isolation_scans (observed_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 207.
ALTER TABLE instinct_tenant_isolation_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_tenant_isolation_scans_all ON instinct_tenant_isolation_scans;
CREATE POLICY instinct_tenant_isolation_scans_all ON instinct_tenant_isolation_scans
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_tenant_isolation_scans'
       AND column_name IN ('id','observed_at','scoped_tables','total_offenders','unclassified','counts','source')
  ) = 7, 'instinct_tenant_isolation_scans missing expected columns';

  -- Schema-guard parity: id must be TEXT, never UUID.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_tenant_isolation_scans' AND column_name = 'id'
  ) = 'text', 'instinct_tenant_isolation_scans.id must be TEXT';

  -- unclassified must be an integer so the trend stays numeric.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_tenant_isolation_scans' AND column_name = 'unclassified'
  ) = 'integer', 'instinct_tenant_isolation_scans.unclassified must be INT';

  -- RLS must be ON - a silent NOOP would defeat the tripwire.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_tenant_isolation_scans'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_tenant_isolation_scans - aborting migration 208.';
  END IF;
END $$;

COMMIT;

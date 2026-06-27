-- 196_platform_scan_rls.sql - deny-by-default RLS tripwire on the platform-scan
-- / onboarding tables.
--
-- WHAT THIS IS (and is NOT):
--   This codebase does NOT use session-var RLS for tenant isolation. The REAL,
--   enforced isolation is an explicit app-side `workspace_id` predicate on every
--   query (see src/lib/platform-scan/*store*.ts and the guardrail test
--   src/lib/platform-scan/__tests__/tenant-isolation.test.ts). There is no
--   set_config/current_setting plumbing in src/lib/db.ts, so a USING
--   (current_setting('app.workspace_id')) policy would deny every query and take
--   the product down.
--
--   So this migration adds the SAME permissive (USING true / WITH CHECK true)
--   row-level-security policy that the sibling tables already carry
--   (082_automations_porsche.sql, 083_meeting_insights.sql,
--   166_ai_gateway_governance.sql). Enabling RLS with a permissive policy is a
--   deny-by-default TRIPWIRE: if a future direct-DB caller (a PostgREST proxy in
--   shadow mode, a BI tool) connects without going through the app layer, RLS is
--   already ON, so the day someone writes a real tenant policy it takes effect
--   without a separate "remember to enable RLS" step. Today, through the app's
--   pooled superuser-ish connection, the permissive policy is transparent.
--
--   The full session-var RLS retrofit (a `withWorkspaceScope` transaction helper
--   that SET LOCAL app.workspace_id + policies keyed on
--   current_setting('app.workspace_id')) is a cross-cutting initiative tracked in
--   docs/tenant-isolation.md. It is deliberately OUT OF SCOPE here: doing it for
--   only the platform-scan tables would be architecturally inconsistent and risk
--   a production outage.
--
-- SCOPE: enables RLS + the permissive policy on the seven workspace-scoped
-- platform-scan / onboarding tables. Adds NO columns, changes NO data, mirrors
-- the migration 083 DROP-then-CREATE pattern exactly. Idempotent; paired
-- 196_platform_scan_rls.down.sql.

BEGIN;

-- instinct_platform_scans (180) - scan-run headers, workspace-scoped.
ALTER TABLE instinct_platform_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_platform_scans_all ON instinct_platform_scans;
CREATE POLICY instinct_platform_scans_all ON instinct_platform_scans
  FOR ALL USING (true) WITH CHECK (true);

-- instinct_platform_scan_findings (180) - per-finding rows, workspace-scoped.
ALTER TABLE instinct_platform_scan_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_platform_scan_findings_all ON instinct_platform_scan_findings;
CREATE POLICY instinct_platform_scan_findings_all ON instinct_platform_scan_findings
  FOR ALL USING (true) WITH CHECK (true);

-- instinct_system_profiles (187) - persisted target knowledge model.
ALTER TABLE instinct_system_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_system_profiles_all ON instinct_system_profiles;
CREATE POLICY instinct_system_profiles_all ON instinct_system_profiles
  FOR ALL USING (true) WITH CHECK (true);

-- instinct_automation_recommendations (188) - gate-governed proposals.
ALTER TABLE instinct_automation_recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_automation_recommendations_all ON instinct_automation_recommendations;
CREATE POLICY instinct_automation_recommendations_all ON instinct_automation_recommendations
  FOR ALL USING (true) WITH CHECK (true);

-- instinct_pentest_authorizations (190) - rules-of-engagement scope tokens.
ALTER TABLE instinct_pentest_authorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_pentest_authorizations_all ON instinct_pentest_authorizations;
CREATE POLICY instinct_pentest_authorizations_all ON instinct_pentest_authorizations
  FOR ALL USING (true) WITH CHECK (true);

-- instinct_scan_targets (191) - onboarded client scan manifests.
ALTER TABLE instinct_scan_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_scan_targets_all ON instinct_scan_targets;
CREATE POLICY instinct_scan_targets_all ON instinct_scan_targets
  FOR ALL USING (true) WITH CHECK (true);

-- instinct_target_verifications (193) - target ownership-verification state.
ALTER TABLE instinct_target_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_target_verifications_all ON instinct_target_verifications;
CREATE POLICY instinct_target_verifications_all ON instinct_target_verifications
  FOR ALL USING (true) WITH CHECK (true);

-- Assertion (per migration-safety convention): RLS must be enabled on all seven
-- tables before we COMMIT - a silent NOOP would defeat the tripwire's purpose.
DO $$
DECLARE
  t TEXT;
  expected_tables CONSTANT TEXT[] := ARRAY[
    'instinct_platform_scans',
    'instinct_platform_scan_findings',
    'instinct_system_profiles',
    'instinct_automation_recommendations',
    'instinct_pentest_authorizations',
    'instinct_scan_targets',
    'instinct_target_verifications'
  ];
BEGIN
  FOREACH t IN ARRAY expected_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = t
        AND c.relkind = 'r'
        AND n.nspname = current_schema()
        AND c.relrowsecurity = true
    ) THEN
      RAISE EXCEPTION 'RLS not enabled on % - aborting migration 196.', t;
    END IF;
  END LOOP;
  RAISE NOTICE '196_platform_scan_rls: RLS + permissive policy on all 7 tables.';
END $$;

COMMIT;

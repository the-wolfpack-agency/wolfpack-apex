-- 296_rls_workspace_policies.sql - replace the permissive RLS tripwire with
-- REAL workspace policies on the tables that already have RLS enabled.
--
-- WHAT CHANGES AND WHAT DOES NOT
--   These tables carry RLS with a permissive `<table>_all USING (true)` policy
--   (migrations 196, 201-215, 216, 232-235, 273). That policy filters nothing.
--   This migration drops it and adds `<table>_ws_isolation`, which admits a row
--   only when its workspace_id equals the transaction-local setting
--   app.workspace_id, or when the transaction is marked app.rls_system = 'on'
--   (cross-workspace system work: crons, sweeps). Unset setting = zero rows.
--
-- WHY THIS IS SAFE TO RUN ON LIVE DATA
--   - No FORCE ROW LEVEL SECURITY. The app connects as the table owner, which
--     has BYPASSRLS on Neon (verified 2026-10-24: neondb_owner, rolbypassrls =
--     true; no other non-bypass role exists). An owner is not subject to a
--     non-FORCE policy, so the running app sees exactly what it saw before.
--   - No roles are created and no grants change.
--   - No columns, no data, no locks beyond the brief ACCESS EXCLUSIVE that
--     ALTER TABLE / CREATE POLICY take on each table.
--   - Idempotent: ENABLE RLS is a no-op when already on; each policy is
--     dropped-if-exists then created. Paired 296_rls_workspace_policies.down.sql
--     restores the permissive policies exactly.
--
-- The policies start filtering only when the app connects as a NOBYPASSRLS
-- role and sets app.workspace_id per request (INSTINCT_RLS_SESSION_CONTEXT=on,
-- src/lib/db/request-workspace.ts). That cutover is a separate, operator-run
-- step: docs/security/rls-cutover.md.
--
-- instinct_gate_api_keys keeps its permissive policy on purpose: a key is
-- resolved from the presented credential before any workspace is known.

-- assistant_routine_runs
DROP POLICY IF EXISTS assistant_routine_runs_all ON assistant_routine_runs;
ALTER TABLE assistant_routine_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_routine_runs_ws_isolation ON assistant_routine_runs;
CREATE POLICY assistant_routine_runs_ws_isolation ON assistant_routine_runs
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- assistant_routine_schedules
DROP POLICY IF EXISTS assistant_routine_schedules_all ON assistant_routine_schedules;
ALTER TABLE assistant_routine_schedules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_routine_schedules_ws_isolation ON assistant_routine_schedules;
CREATE POLICY assistant_routine_schedules_ws_isolation ON assistant_routine_schedules
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- assistant_routine_steps
DROP POLICY IF EXISTS assistant_routine_steps_all ON assistant_routine_steps;
ALTER TABLE assistant_routine_steps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_routine_steps_ws_isolation ON assistant_routine_steps;
CREATE POLICY assistant_routine_steps_ws_isolation ON assistant_routine_steps
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- assistant_saved_routines
DROP POLICY IF EXISTS assistant_saved_routines_all ON assistant_saved_routines;
ALTER TABLE assistant_saved_routines ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS assistant_saved_routines_ws_isolation ON assistant_saved_routines;
CREATE POLICY assistant_saved_routines_ws_isolation ON assistant_saved_routines
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_admin_mfa
DROP POLICY IF EXISTS instinct_admin_mfa_all ON instinct_admin_mfa;
ALTER TABLE instinct_admin_mfa ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_admin_mfa_ws_isolation ON instinct_admin_mfa;
CREATE POLICY instinct_admin_mfa_ws_isolation ON instinct_admin_mfa
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_ai_code_reviews
DROP POLICY IF EXISTS instinct_ai_code_reviews_all ON instinct_ai_code_reviews;
ALTER TABLE instinct_ai_code_reviews ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_code_reviews_ws_isolation ON instinct_ai_code_reviews;
CREATE POLICY instinct_ai_code_reviews_ws_isolation ON instinct_ai_code_reviews
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_ai_code_watched_repos
DROP POLICY IF EXISTS instinct_ai_code_watched_repos_all ON instinct_ai_code_watched_repos;
ALTER TABLE instinct_ai_code_watched_repos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_code_watched_repos_ws_isolation ON instinct_ai_code_watched_repos;
CREATE POLICY instinct_ai_code_watched_repos_ws_isolation ON instinct_ai_code_watched_repos
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_ai_redteam_runs
DROP POLICY IF EXISTS instinct_ai_redteam_runs_all ON instinct_ai_redteam_runs;
ALTER TABLE instinct_ai_redteam_runs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_redteam_runs_ws_isolation ON instinct_ai_redteam_runs;
CREATE POLICY instinct_ai_redteam_runs_ws_isolation ON instinct_ai_redteam_runs
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_ai_surfaces
DROP POLICY IF EXISTS instinct_ai_surfaces_all ON instinct_ai_surfaces;
ALTER TABLE instinct_ai_surfaces ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_ai_surfaces_ws_isolation ON instinct_ai_surfaces;
CREATE POLICY instinct_ai_surfaces_ws_isolation ON instinct_ai_surfaces
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_automation_recommendations
DROP POLICY IF EXISTS instinct_automation_recommendations_all ON instinct_automation_recommendations;
ALTER TABLE instinct_automation_recommendations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_automation_recommendations_ws_isolation ON instinct_automation_recommendations;
CREATE POLICY instinct_automation_recommendations_ws_isolation ON instinct_automation_recommendations
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_compliance_reports
DROP POLICY IF EXISTS instinct_compliance_reports_all ON instinct_compliance_reports;
ALTER TABLE instinct_compliance_reports ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_compliance_reports_ws_isolation ON instinct_compliance_reports;
CREATE POLICY instinct_compliance_reports_ws_isolation ON instinct_compliance_reports
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_cross_scan_insights
DROP POLICY IF EXISTS instinct_cross_scan_insights_all ON instinct_cross_scan_insights;
ALTER TABLE instinct_cross_scan_insights ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_cross_scan_insights_ws_isolation ON instinct_cross_scan_insights;
CREATE POLICY instinct_cross_scan_insights_ws_isolation ON instinct_cross_scan_insights
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_governance_alerts
DROP POLICY IF EXISTS instinct_governance_alerts_all ON instinct_governance_alerts;
ALTER TABLE instinct_governance_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_governance_alerts_ws_isolation ON instinct_governance_alerts;
CREATE POLICY instinct_governance_alerts_ws_isolation ON instinct_governance_alerts
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_pentest_authorizations
DROP POLICY IF EXISTS instinct_pentest_authorizations_all ON instinct_pentest_authorizations;
ALTER TABLE instinct_pentest_authorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_pentest_authorizations_ws_isolation ON instinct_pentest_authorizations;
CREATE POLICY instinct_pentest_authorizations_ws_isolation ON instinct_pentest_authorizations
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_platform_scan_findings
DROP POLICY IF EXISTS instinct_platform_scan_findings_all ON instinct_platform_scan_findings;
ALTER TABLE instinct_platform_scan_findings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_platform_scan_findings_ws_isolation ON instinct_platform_scan_findings;
CREATE POLICY instinct_platform_scan_findings_ws_isolation ON instinct_platform_scan_findings
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_platform_scans
DROP POLICY IF EXISTS instinct_platform_scans_all ON instinct_platform_scans;
ALTER TABLE instinct_platform_scans ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_platform_scans_ws_isolation ON instinct_platform_scans;
CREATE POLICY instinct_platform_scans_ws_isolation ON instinct_platform_scans
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_scan_targets
DROP POLICY IF EXISTS instinct_scan_targets_all ON instinct_scan_targets;
ALTER TABLE instinct_scan_targets ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_scan_targets_ws_isolation ON instinct_scan_targets;
CREATE POLICY instinct_scan_targets_ws_isolation ON instinct_scan_targets
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_system_profiles
DROP POLICY IF EXISTS instinct_system_profiles_all ON instinct_system_profiles;
ALTER TABLE instinct_system_profiles ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_system_profiles_ws_isolation ON instinct_system_profiles;
CREATE POLICY instinct_system_profiles_ws_isolation ON instinct_system_profiles
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- instinct_target_verifications
DROP POLICY IF EXISTS instinct_target_verifications_all ON instinct_target_verifications;
ALTER TABLE instinct_target_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_target_verifications_ws_isolation ON instinct_target_verifications;
CREATE POLICY instinct_target_verifications_ws_isolation ON instinct_target_verifications
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- ogiam_enforcement_policy
DROP POLICY IF EXISTS ogiam_enforcement_policy_all ON ogiam_enforcement_policy;
ALTER TABLE ogiam_enforcement_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ogiam_enforcement_policy_ws_isolation ON ogiam_enforcement_policy;
CREATE POLICY ogiam_enforcement_policy_ws_isolation ON ogiam_enforcement_policy
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');

-- workspace_ai_policy
DROP POLICY IF EXISTS workspace_ai_policy_all ON workspace_ai_policy;
ALTER TABLE workspace_ai_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS workspace_ai_policy_ws_isolation ON workspace_ai_policy;
CREATE POLICY workspace_ai_policy_ws_isolation ON workspace_ai_policy
  FOR ALL USING (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on')
  WITH CHECK (workspace_id = NULLIF(current_setting('app.workspace_id', true), '') OR current_setting('app.rls_system', true) = 'on');


-- Assertion: every listed table now has RLS enabled, the workspace policy, no
-- permissive USING (true) policy left beside it, and NO FORCE (FORCE would make
-- the owner connection the app uses today subject to the policy = outage).
DO $$
DECLARE
  t TEXT;
  expected_tables CONSTANT TEXT[] := ARRAY[
    'assistant_routine_runs',
    'assistant_routine_schedules',
    'assistant_routine_steps',
    'assistant_saved_routines',
    'instinct_admin_mfa',
    'instinct_ai_code_reviews',
    'instinct_ai_code_watched_repos',
    'instinct_ai_redteam_runs',
    'instinct_ai_surfaces',
    'instinct_automation_recommendations',
    'instinct_compliance_reports',
    'instinct_cross_scan_insights',
    'instinct_governance_alerts',
    'instinct_pentest_authorizations',
    'instinct_platform_scan_findings',
    'instinct_platform_scans',
    'instinct_scan_targets',
    'instinct_system_profiles',
    'instinct_target_verifications',
    'ogiam_enforcement_policy',
    'workspace_ai_policy'
  ];
BEGIN
  FOREACH t IN ARRAY expected_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relname = t AND n.nspname = current_schema() AND c.relkind = 'r'
         AND c.relrowsecurity AND NOT c.relforcerowsecurity
    ) THEN
      RAISE EXCEPTION 'migration 296: % is not RLS-enabled without FORCE', t;
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = t AND p.polname = t || '_ws_isolation'
    ) THEN
      RAISE EXCEPTION 'migration 296: % has no workspace policy', t;
    END IF;
    IF EXISTS (
      SELECT 1 FROM pg_policy p JOIN pg_class c ON c.oid = p.polrelid
       WHERE c.relname = t AND pg_get_expr(p.polqual, p.polrelid) = 'true'
    ) THEN
      RAISE EXCEPTION 'migration 296: % still has a permissive USING (true) policy', t;
    END IF;
  END LOOP;
END $$;

-- Down for migration 296: drop the workspace policies and restore the
-- permissive `<table>_all USING (true)` tripwire each table had before. RLS
-- stays enabled, as it was before 296. No data is touched. Idempotent.

DROP POLICY IF EXISTS assistant_routine_runs_ws_isolation ON assistant_routine_runs;
DROP POLICY IF EXISTS assistant_routine_runs_all ON assistant_routine_runs;
CREATE POLICY assistant_routine_runs_all ON assistant_routine_runs FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS assistant_routine_schedules_ws_isolation ON assistant_routine_schedules;
DROP POLICY IF EXISTS assistant_routine_schedules_all ON assistant_routine_schedules;
CREATE POLICY assistant_routine_schedules_all ON assistant_routine_schedules FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS assistant_routine_steps_ws_isolation ON assistant_routine_steps;
DROP POLICY IF EXISTS assistant_routine_steps_all ON assistant_routine_steps;
CREATE POLICY assistant_routine_steps_all ON assistant_routine_steps FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS assistant_saved_routines_ws_isolation ON assistant_saved_routines;
DROP POLICY IF EXISTS assistant_saved_routines_all ON assistant_saved_routines;
CREATE POLICY assistant_saved_routines_all ON assistant_saved_routines FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_admin_mfa_ws_isolation ON instinct_admin_mfa;
DROP POLICY IF EXISTS instinct_admin_mfa_all ON instinct_admin_mfa;
CREATE POLICY instinct_admin_mfa_all ON instinct_admin_mfa FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_ai_code_reviews_ws_isolation ON instinct_ai_code_reviews;
DROP POLICY IF EXISTS instinct_ai_code_reviews_all ON instinct_ai_code_reviews;
CREATE POLICY instinct_ai_code_reviews_all ON instinct_ai_code_reviews FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_ai_code_watched_repos_ws_isolation ON instinct_ai_code_watched_repos;
DROP POLICY IF EXISTS instinct_ai_code_watched_repos_all ON instinct_ai_code_watched_repos;
CREATE POLICY instinct_ai_code_watched_repos_all ON instinct_ai_code_watched_repos FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_ai_redteam_runs_ws_isolation ON instinct_ai_redteam_runs;
DROP POLICY IF EXISTS instinct_ai_redteam_runs_all ON instinct_ai_redteam_runs;
CREATE POLICY instinct_ai_redteam_runs_all ON instinct_ai_redteam_runs FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_ai_surfaces_ws_isolation ON instinct_ai_surfaces;
DROP POLICY IF EXISTS instinct_ai_surfaces_all ON instinct_ai_surfaces;
CREATE POLICY instinct_ai_surfaces_all ON instinct_ai_surfaces FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_automation_recommendations_ws_isolation ON instinct_automation_recommendations;
DROP POLICY IF EXISTS instinct_automation_recommendations_all ON instinct_automation_recommendations;
CREATE POLICY instinct_automation_recommendations_all ON instinct_automation_recommendations FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_compliance_reports_ws_isolation ON instinct_compliance_reports;
DROP POLICY IF EXISTS instinct_compliance_reports_all ON instinct_compliance_reports;
CREATE POLICY instinct_compliance_reports_all ON instinct_compliance_reports FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_cross_scan_insights_ws_isolation ON instinct_cross_scan_insights;
DROP POLICY IF EXISTS instinct_cross_scan_insights_all ON instinct_cross_scan_insights;
CREATE POLICY instinct_cross_scan_insights_all ON instinct_cross_scan_insights FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_governance_alerts_ws_isolation ON instinct_governance_alerts;
DROP POLICY IF EXISTS instinct_governance_alerts_all ON instinct_governance_alerts;
CREATE POLICY instinct_governance_alerts_all ON instinct_governance_alerts FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_pentest_authorizations_ws_isolation ON instinct_pentest_authorizations;
DROP POLICY IF EXISTS instinct_pentest_authorizations_all ON instinct_pentest_authorizations;
CREATE POLICY instinct_pentest_authorizations_all ON instinct_pentest_authorizations FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_platform_scan_findings_ws_isolation ON instinct_platform_scan_findings;
DROP POLICY IF EXISTS instinct_platform_scan_findings_all ON instinct_platform_scan_findings;
CREATE POLICY instinct_platform_scan_findings_all ON instinct_platform_scan_findings FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_platform_scans_ws_isolation ON instinct_platform_scans;
DROP POLICY IF EXISTS instinct_platform_scans_all ON instinct_platform_scans;
CREATE POLICY instinct_platform_scans_all ON instinct_platform_scans FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_scan_targets_ws_isolation ON instinct_scan_targets;
DROP POLICY IF EXISTS instinct_scan_targets_all ON instinct_scan_targets;
CREATE POLICY instinct_scan_targets_all ON instinct_scan_targets FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_system_profiles_ws_isolation ON instinct_system_profiles;
DROP POLICY IF EXISTS instinct_system_profiles_all ON instinct_system_profiles;
CREATE POLICY instinct_system_profiles_all ON instinct_system_profiles FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS instinct_target_verifications_ws_isolation ON instinct_target_verifications;
DROP POLICY IF EXISTS instinct_target_verifications_all ON instinct_target_verifications;
CREATE POLICY instinct_target_verifications_all ON instinct_target_verifications FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS ogiam_enforcement_policy_ws_isolation ON ogiam_enforcement_policy;
DROP POLICY IF EXISTS ogiam_enforcement_policy_all ON ogiam_enforcement_policy;
CREATE POLICY ogiam_enforcement_policy_all ON ogiam_enforcement_policy FOR ALL USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS workspace_ai_policy_ws_isolation ON workspace_ai_policy;
DROP POLICY IF EXISTS workspace_ai_policy_all ON workspace_ai_policy;
CREATE POLICY workspace_ai_policy_all ON workspace_ai_policy FOR ALL USING (true) WITH CHECK (true);


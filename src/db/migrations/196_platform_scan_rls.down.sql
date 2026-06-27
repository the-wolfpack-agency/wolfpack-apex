-- Down for migration 196 - remove the deny-by-default RLS tripwire from the
-- platform-scan / onboarding tables. Drops the permissive policy and disables
-- row-level security on each of the seven tables. Idempotent (IF EXISTS); the
-- table rows themselves are untouched (this migration never wrote data).

BEGIN;

DROP POLICY IF EXISTS instinct_platform_scans_all ON instinct_platform_scans;
ALTER TABLE instinct_platform_scans DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_platform_scan_findings_all ON instinct_platform_scan_findings;
ALTER TABLE instinct_platform_scan_findings DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_system_profiles_all ON instinct_system_profiles;
ALTER TABLE instinct_system_profiles DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_automation_recommendations_all ON instinct_automation_recommendations;
ALTER TABLE instinct_automation_recommendations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_pentest_authorizations_all ON instinct_pentest_authorizations;
ALTER TABLE instinct_pentest_authorizations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_scan_targets_all ON instinct_scan_targets;
ALTER TABLE instinct_scan_targets DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instinct_target_verifications_all ON instinct_target_verifications;
ALTER TABLE instinct_target_verifications DISABLE ROW LEVEL SECURITY;

COMMIT;

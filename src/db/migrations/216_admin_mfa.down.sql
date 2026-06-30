-- Down migration for 216_admin_mfa.sql.
-- Drops the admin MFA enrollment table, its index, and its RLS policy. Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_admin_mfa_all ON instinct_admin_mfa;
DROP INDEX IF EXISTS idx_admin_mfa_workspace_user;
DROP TABLE IF EXISTS instinct_admin_mfa;

COMMIT;

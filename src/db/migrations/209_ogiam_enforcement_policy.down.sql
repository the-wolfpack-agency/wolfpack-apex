-- Down migration for 209_ogiam_enforcement_policy.sql.
-- Drops the per-capability enforcement-posture table, its index, and RLS policy.
-- Idempotent.

BEGIN;

DROP POLICY IF EXISTS ogiam_enforcement_policy_all ON ogiam_enforcement_policy;
DROP INDEX IF EXISTS idx_ogiam_enforcement_policy_workspace;
DROP TABLE IF EXISTS ogiam_enforcement_policy;

COMMIT;

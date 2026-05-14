-- Down migration for 132_purge_future_dated_knowledge.sql
--
-- DELETE migrations have no clean inverse — the rows are gone. The most
-- responsible no-op rollback is to record the migration as reverted so
-- the migration runner doesn't refuse to apply 132 again on rollback +
-- replay. The actual data is lost.
--
-- If you need the original rows back, restore from a Neon point-in-time
-- backup taken before this migration ran.

BEGIN;

-- Intentionally no-op. Document the rollback for the migrate runner.
SELECT 1 AS noop_rollback;

COMMIT;

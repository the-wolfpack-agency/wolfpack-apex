BEGIN;
DROP INDEX IF EXISTS idx_pending_actions_expiring;
DROP INDEX IF EXISTS idx_pending_actions_user_alive;
DROP TABLE IF EXISTS instinct_pending_actions;
COMMIT;

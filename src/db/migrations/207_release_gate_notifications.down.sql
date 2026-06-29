-- Down migration for 207_release_gate_notifications.sql.
-- Drops the release-gate notification dedupe ledger, its indexes, and its RLS
-- policy. Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_release_gate_notifications_all ON instinct_release_gate_notifications;
DROP INDEX IF EXISTS idx_release_gate_notifications_notified_at;
DROP INDEX IF EXISTS idx_release_gate_notifications_pr;
DROP TABLE IF EXISTS instinct_release_gate_notifications;

COMMIT;

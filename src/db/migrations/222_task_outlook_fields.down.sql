-- Down migration for 222_task_outlook_fields.
--
-- Idempotent rollback: drops the columns + index added by the forward
-- migration. Guarded with IF EXISTS so re-running is safe.

BEGIN;

DROP INDEX IF EXISTS idx_instinct_tasks_user_reminder;

ALTER TABLE instinct_tasks DROP COLUMN IF EXISTS reminder_at;
ALTER TABLE instinct_tasks DROP COLUMN IF EXISTS is_reminder_on;
ALTER TABLE instinct_tasks DROP COLUMN IF EXISTS start_at;
ALTER TABLE instinct_tasks DROP COLUMN IF EXISTS categories;

COMMIT;

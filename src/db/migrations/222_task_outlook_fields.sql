-- Migration 222: Microsoft To Do — additional Outlook task fields.
--
-- Adds the Outlook/To Do fields the Tasks surface was missing so a task
-- carries the same shape Microsoft To Do exposes: a reminder
-- (reminderDateTime + isReminderOn), a start date (startDateTime), and
-- categories. Assignment is deliberately NOT here: To Do tasks are
-- personal and have no assignments in Graph — assigning a task to an
-- individual maps to Microsoft Planner (instinct_planner_tasks.assignees),
-- which already supports it. See src/lib/integrations/microsoft-planner.ts.
--
-- Additive + idempotent only: every column is guarded with IF NOT EXISTS
-- so re-running is a no-op and no existing row is disturbed. Graph stays
-- the source of truth; these columns mirror the write-through payload.

BEGIN;

ALTER TABLE instinct_tasks
  ADD COLUMN IF NOT EXISTS reminder_at     TIMESTAMPTZ;

ALTER TABLE instinct_tasks
  ADD COLUMN IF NOT EXISTS is_reminder_on  BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE instinct_tasks
  ADD COLUMN IF NOT EXISTS start_at        TIMESTAMPTZ;

ALTER TABLE instinct_tasks
  ADD COLUMN IF NOT EXISTS categories      JSONB NOT NULL DEFAULT '[]'::jsonb;

-- Partial index so the reminder digest / "due soon" surfaces can find
-- tasks with an active reminder without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_instinct_tasks_user_reminder
  ON instinct_tasks (user_id, reminder_at)
  WHERE is_reminder_on = true;

COMMIT;

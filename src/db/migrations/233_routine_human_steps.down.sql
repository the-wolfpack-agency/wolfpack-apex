-- Rollback for 233_routine_human_steps.
--
-- Human steps still pause and are still timed; only the review/do distinction
-- and the completion view are lost.

DROP VIEW IF EXISTS v_routine_human_steps;
ALTER TABLE assistant_routine_steps
  DROP CONSTRAINT IF EXISTS assistant_routine_steps_human_action_chk;
ALTER TABLE assistant_routine_steps
  DROP COLUMN IF EXISTS human_action;

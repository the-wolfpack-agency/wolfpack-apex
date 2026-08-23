-- Rollback for 236_routine_answers.
--
-- Steps that ask for a value stop working: the question can still be posed but
-- the answer is lost between messages, so the step never runs. Routines that
-- ask for nothing are unaffected.

ALTER TABLE assistant_routine_runs DROP COLUMN IF EXISTS pending_ask;
ALTER TABLE assistant_routine_runs DROP COLUMN IF EXISTS answers;

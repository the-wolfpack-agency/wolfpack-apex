-- 236_routine_answers
--
-- The values somebody supplied to a step that asked.
--
-- A step can now ask for what it needs: searching mail has to know what to
-- search for, listing CI runs has to know which repository. Neither has a
-- sensible default, and a routine that guessed would be doing the confident
-- wrong thing this product exists to avoid.
--
-- WHY THESE ARE STORED WHEN SLOTS ARE NOT
--
-- Migration 232 deliberately does not store slot values, because a slot holds
-- whatever a tool returned: mail bodies, customer history, draft replies. A
-- table of those is a second copy of the mailbox without the mailbox's
-- controls.
--
-- An answer is a different thing. It is short, the person typed it on purpose
-- knowing it was going into a workflow, and it has to survive between messages
-- or the step that asked could never run: the question is asked in one request
-- and answered in the next.
--
-- Keyed "stepIndex:param" so the same parameter name on two steps cannot
-- collide, and so an answer is meaningless outside the run it belongs to.
--
-- Idempotent. Paired rollback in 236_routine_answers.down.sql.

ALTER TABLE assistant_routine_runs
  ADD COLUMN IF NOT EXISTS answers JSONB NOT NULL DEFAULT '{}'::jsonb;

-- The step and parameter a waiting run is asking about. Null unless it is
-- waiting for a value, so "what is this run waiting for" is a column read
-- rather than something reconstructed from the routine definition.
ALTER TABLE assistant_routine_runs
  ADD COLUMN IF NOT EXISTS pending_ask JSONB;

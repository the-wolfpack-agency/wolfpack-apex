-- 233_routine_human_steps
--
-- Which human steps are reviews, which are work only a person can do, and
-- which are quietly not happening.
--
-- Migration 232 recorded that a routine stopped for somebody and how long they
-- took. It could not tell two very different pauses apart:
--
--   * "check this draft before it sends"   -- a checkpoint on the machine
--   * "rehearse the pitch out loud"        -- work no software can perform
--
-- The interesting finding differs. A review always accepted unchanged is a
-- pause worth deleting. A "do" always skipped is something else: either it does
-- not matter and should come out of the routine, or it matters and is not
-- getting done, which for a client-facing role is frequently the thing that
-- decided how the quarter went. Nobody currently holds that fact about their
-- own week.
--
-- SKIPS ARE RECORDED WITHOUT PENALTY, and the product must never treat one as a
-- failure. A routine that punishes a skip gets one of two responses: people
-- stop running it, or they tick the box without doing the thing. Either way the
-- measurement dies, and the measurement is the whole point.
--
-- Idempotent. Paired rollback in 233_routine_human_steps.down.sql.

ALTER TABLE assistant_routine_steps
  ADD COLUMN IF NOT EXISTS human_action TEXT;

ALTER TABLE assistant_routine_steps
  DROP CONSTRAINT IF EXISTS assistant_routine_steps_human_action_chk;
ALTER TABLE assistant_routine_steps
  ADD CONSTRAINT assistant_routine_steps_human_action_chk
  CHECK (human_action IS NULL OR human_action IN ('review', 'do'));

-- Where a person's own steps are going, per routine step.
--
-- One row per human step of per routine, with completion separated from time
-- spent. This is what turns "I think people skip that bit" into a number, and
-- it is deliberately a view rather than a report: the recommendation belongs in
-- code where it can be read and argued with, not frozen into SQL.
CREATE OR REPLACE VIEW v_routine_human_steps AS
SELECT
  r.routine_id,
  s.step_index,
  s.label,
  COALESCE(s.human_action, 'review')                    AS human_action,
  COUNT(*)                                              AS asked,
  COUNT(*) FILTER (WHERE s.status = 'ok')               AS completed,
  COUNT(*) FILTER (WHERE s.status = 'skipped')          AS skipped,
  -- Time spent only on the runs where the person actually did it. Including
  -- skipped runs would average in the ones where nobody spent the time, and
  -- make a step look cheap precisely because it is being avoided.
  ROUND(AVG(s.duration_ms) FILTER (WHERE s.status = 'ok')) AS avg_ms_when_done
FROM assistant_routine_steps s
JOIN assistant_routine_runs r ON r.run_id = s.run_id
WHERE s.kind = 'human'
GROUP BY r.routine_id, s.step_index, s.label, COALESCE(s.human_action, 'review');

-- 237_human_step_latency
--
-- The fastest a human step has ever been done.
--
-- WHY THIS ONE NUMBER MATTERS
--
-- What a routine records for a human step is the elapsed time from being asked
-- to being done, and that is latency AND work together. They cannot be split
-- without asking somebody, and asking would make the measurement worse by
-- turning every step into a form.
--
-- The best run is the honest proxy. A step whose average is an hour and whose
-- best is four minutes is not an hour of effort: it is four minutes that
-- usually waits an hour. Those two readings call for opposite responses. An
-- expensive step wants a tool; a late step wants to sit somewhere else in the
-- day, and preparation done after the thing it was for did not happen at all.
--
-- Nobody measures the human side of a workflow, so nobody notices that the
-- problem with somebody's preparation is WHEN they do it rather than how long
-- it takes. This is the column that makes that visible.
--
-- Idempotent. Paired rollback in 237_human_step_latency.down.sql.

CREATE OR REPLACE VIEW v_routine_human_steps AS
SELECT
  r.routine_id,
  s.step_index,
  s.label,
  COALESCE(s.human_action, 'review')                    AS human_action,
  COUNT(*)                                              AS asked,
  COUNT(*) FILTER (WHERE s.status = 'ok')               AS completed,
  COUNT(*) FILTER (WHERE s.status = 'skipped')          AS skipped,
  ROUND(AVG(s.duration_ms) FILTER (WHERE s.status = 'ok')) AS avg_ms_when_done,
  -- The run where they got to it soonest. Mostly work, least waiting.
  MIN(s.duration_ms) FILTER (WHERE s.status = 'ok')     AS fastest_ms_when_done
FROM assistant_routine_steps s
JOIN assistant_routine_runs r ON r.run_id = s.run_id
WHERE s.kind = 'human'
GROUP BY r.routine_id, s.step_index, s.label, COALESCE(s.human_action, 'review');

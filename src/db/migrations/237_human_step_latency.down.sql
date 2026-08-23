-- Rollback for 237_human_step_latency.
--
-- Restores the view without the fastest-run column. The insight layer degrades
-- to reporting a step as expensive when it may only be late.

CREATE OR REPLACE VIEW v_routine_human_steps AS
SELECT
  r.routine_id,
  s.step_index,
  s.label,
  COALESCE(s.human_action, 'review')                    AS human_action,
  COUNT(*)                                              AS asked,
  COUNT(*) FILTER (WHERE s.status = 'ok')               AS completed,
  COUNT(*) FILTER (WHERE s.status = 'skipped')          AS skipped,
  ROUND(AVG(s.duration_ms) FILTER (WHERE s.status = 'ok')) AS avg_ms_when_done
FROM assistant_routine_steps s
JOIN assistant_routine_runs r ON r.run_id = s.run_id
WHERE s.kind = 'human'
GROUP BY r.routine_id, s.step_index, s.label, COALESCE(s.human_action, 'review');

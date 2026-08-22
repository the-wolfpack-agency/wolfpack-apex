-- Rollback for 232_assistant_routine_runs.
--
-- Drops the measurement, not the capability: routines still run, they simply
-- stop recording where a person's time goes.

DROP VIEW IF EXISTS v_routine_step_cost;
DROP TABLE IF EXISTS assistant_routine_steps;
DROP TABLE IF EXISTS assistant_routine_runs;

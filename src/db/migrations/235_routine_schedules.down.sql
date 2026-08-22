-- Rollback for 235_routine_schedules.
--
-- Routines still run when typed. Only the standing appointments are lost, so
-- people who relied on one will simply stop being met by it.

DROP TABLE IF EXISTS assistant_routine_schedules;

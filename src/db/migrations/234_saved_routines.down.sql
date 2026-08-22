-- Rollback for 234_saved_routines.
--
-- The built-in routines still run. Only the chains people saved for themselves
-- are lost, so this is not a rollback to run casually.

DROP TABLE IF EXISTS assistant_saved_routines;

-- Down migration for 177_ogiam_immutability_triggers.sql.
-- Removes the append-only triggers and the shared function. The ledger rows
-- themselves are untouched.

DROP TRIGGER IF EXISTS ogiam_decisions_no_update ON ogiam_decisions;
DROP TRIGGER IF EXISTS ogiam_action_outcomes_no_update ON ogiam_action_outcomes;
DROP FUNCTION IF EXISTS ogiam_ledger_immutable();

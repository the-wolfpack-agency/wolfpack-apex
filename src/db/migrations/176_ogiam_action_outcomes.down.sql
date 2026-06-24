-- Down migration for 176_ogiam_action_outcomes.sql.
-- Drops the outcomes table. The decision ledger is untouched.

DROP TABLE IF EXISTS ogiam_action_outcomes;

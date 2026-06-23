-- Down for 169: drop the OGIAM decision ledger. The ledger is an evidence
-- stream, not a source of truth for any other entity, so dropping it on
-- rollback loses only the recorded decisions.
DROP TABLE IF EXISTS ogiam_decisions;

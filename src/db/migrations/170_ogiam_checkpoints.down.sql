-- Down for 170: drop the checkpoints table and the hash_payload column.
-- Both are notarization aids over the decision ledger, not the source of truth,
-- so a rollback loses only the signatures and the verifiable-payload snapshot.
DROP TABLE IF EXISTS ogiam_checkpoints;
ALTER TABLE ogiam_decisions DROP COLUMN IF EXISTS hash_payload;

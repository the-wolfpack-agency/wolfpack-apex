-- Down for 167 dedup: intentionally a no-op.
-- This migration DELETED duplicate feedback rows. Those deletes are
-- unrecoverable: the duplicate rows carried no information the surviving row
-- in each group does not already carry (same workspace, user, and message; the
-- earliest/resolved row was kept on purpose). There is nothing to restore and
-- nothing to undo, so rolling back is a no-op rather than a re-insert of data
-- we deliberately discarded.
SELECT 1;

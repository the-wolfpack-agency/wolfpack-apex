-- 106_mailbox_poll_cursors.down.sql — reversible teardown of 106.
--
-- Drops the per-base cursor table + its indexes. IF EXISTS everywhere so
-- the down migration is safe to re-run.
--
-- WARNING: dropping this table loses every cursor that was written via
-- the new code path. After a down + up cycle the next poll will start
-- with a cold cursor on each (user_id, mailbox_base) and pull the last
-- 30 days of mail (the inbox-poller fallback window). Artifact-level
-- dedup ((source_message_id, content_sha256) UNIQUE) prevents duplicate
-- ingest. The legacy `instinct_automation_porsche_poll_state` table is
-- preserved by 106 specifically so an emergency rollback does not also
-- lose the original delta links.

BEGIN;

DROP INDEX IF EXISTS idx_mailbox_poll_cursors_base;
DROP INDEX IF EXISTS idx_mailbox_poll_cursors_user;

DROP TABLE IF EXISTS mailbox_poll_cursors;

COMMIT;

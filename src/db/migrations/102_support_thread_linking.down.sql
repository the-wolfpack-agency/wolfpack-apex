-- 102_support_thread_linking.down.sql — reversible teardown of 102.
--
-- Drops the poll-state table, the per-message audit table, and the three
-- thread-linking columns + their index. IF EXISTS everywhere so the down
-- migration is safe to re-run.
--
-- WARNING: this drops the per-ticket message thread audit trail AND the
-- inbox poller cursor. After a down + up, the next poll will start from
-- "now" because last_received_at is NULL — historic emails won't be
-- re-ingested. Existing tickets keep their bodies and draft_response.

BEGIN;

DROP TABLE IF EXISTS instinct_support_poll_state;

DROP INDEX IF EXISTS idx_support_ticket_messages_graph_message_id;
DROP INDEX IF EXISTS idx_support_ticket_messages_ticket_id;
DROP TABLE IF EXISTS instinct_support_ticket_messages;

DROP INDEX IF EXISTS idx_support_tickets_graph_conversation_id;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS graph_conversation_id;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS graph_internet_message_id;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS graph_message_id;

COMMIT;

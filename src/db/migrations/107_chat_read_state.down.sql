-- 107_chat_read_state.down.sql — reversible teardown of 107.
--
-- Drops the index then the table. IF EXISTS everywhere so the down
-- migration is safe to re-run.
--
-- WARNING: this drops every per-user read-state row. After a down + up
-- cycle the chat list on /messages will show every chat as unread
-- until each user opens it again. No user data is lost — read-state
-- is purely a UI driver.

BEGIN;

DROP INDEX IF EXISTS idx_chat_read_state_user;

DROP TABLE IF EXISTS chat_read_state;

COMMIT;

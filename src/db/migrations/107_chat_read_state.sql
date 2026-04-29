-- 107_chat_read_state.sql — per-user-per-chat last-read timestamp.
--
-- Goal: drive the "bold + dot" unread visualization on /messages
-- (chats / channels / teams) without leaning on Graph's missing per-
-- chat unread field. We compare `lastMessage.createdDateTime` against
-- the row written here on chat open. Same table powers chats, channels,
-- and teams; `chat_id` carries whichever Graph object id the surface
-- needs (chat / channel / team / chat:thread). The schema is kind-
-- agnostic on purpose so we don't fork the table per surface.
--
-- Schema choices:
--   * `user_id TEXT NOT NULL` — matches `mailbox_poll_cursors`
--     (TEXT, not UUID — can be UPN or UUID-shaped string).
--   * `(user_id, chat_id) UNIQUE` — one row per (user, surface). Upsert
--     advances `last_read_at` forward only via the read-state lib.
--   * NO RLS — matches the convention used by mailbox_poll_cursors.
--     All access goes through API routes that authenticate the caller
--     and scope queries by `user_id` server-side.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on the table + indexes.
--   * Final DO block ASSERTs structure.
--   * Down migration drops in reverse order with IF EXISTS.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- chat_read_state
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_read_state (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  last_read_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (user_id, chat_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_read_state_user
  ON chat_read_state (user_id);

-- ============================================================
-- Structure assertions (per memory feedback_migration_safety)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'chat_read_state'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'chat_read_state not created — aborting migration 107.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_chat_read_state_user'
  ) THEN
    RAISE EXCEPTION 'idx_chat_read_state_user missing — aborting migration 107.';
  END IF;
  RAISE NOTICE '107_chat_read_state: 1 table + 1 index created.';
END $$;

COMMIT;

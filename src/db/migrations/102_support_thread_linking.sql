-- 102_support_thread_linking.sql — thread-link incoming email replies to
-- existing support tickets, and persist a poll cursor for the inbox poller.
--
-- The Support feature originally only created tickets via the manual /support
-- form. Today we are adding an inbox poller that auto-creates tickets from
-- incoming emails to support@thewolfpack.agency. To make customer replies
-- land on the SAME ticket (not a duplicate) we need to remember each
-- ticket's Microsoft Graph conversation id, internet message id, and the
-- specific message id that started it. We also need a per-message audit
-- trail so the operator can see the full thread on the ticket detail page.
--
-- Three things this migration adds:
--   1. graph_message_id / graph_internet_message_id / graph_conversation_id
--      columns on instinct_support_tickets, plus an index on
--      graph_conversation_id to make "find ticket by conversation" cheap.
--   2. instinct_support_ticket_messages — every inbound and outbound message
--      attached to a ticket, with direction + Graph message id + body.
--   3. instinct_support_poll_state — single-row cursor for the inbox poller
--      (one row keyed by 'support-inbox') tracking the highest
--      receivedDateTime we've successfully ingested. Mirrors the porsche-
--      classes per-(automation,user) cursor pattern but scoped to the
--      single shared support mailbox.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on column adds, table creates, indexes.
--   * Final DO block ASSERTs every new column / table / index exists.
--   * Down migration drops in reverse order with IF EXISTS.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- 1. Thread-linking columns on instinct_support_tickets
-- ============================================================
ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS graph_message_id TEXT;

ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS graph_internet_message_id TEXT;

ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS graph_conversation_id TEXT;

CREATE INDEX IF NOT EXISTS idx_support_tickets_graph_conversation_id
  ON instinct_support_tickets(graph_conversation_id);

-- ============================================================
-- 2. Per-message audit table
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_support_ticket_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ticket_id UUID NOT NULL REFERENCES instinct_support_tickets(id) ON DELETE CASCADE,
  direction TEXT NOT NULL,
  graph_message_id TEXT,
  internet_message_id TEXT,
  from_email TEXT,
  body TEXT,
  received_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_support_ticket_messages_direction_chk
    CHECK (direction IN ('inbound', 'outbound'))
);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_ticket_id
  ON instinct_support_ticket_messages(ticket_id);

CREATE INDEX IF NOT EXISTS idx_support_ticket_messages_graph_message_id
  ON instinct_support_ticket_messages(graph_message_id);

-- ============================================================
-- 3. Single-row poll cursor for the inbox poller
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_support_poll_state (
  id TEXT PRIMARY KEY,
  last_received_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ============================================================
-- Structure assertions (per memory feedback_migration_safety)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'graph_message_id'
  ) THEN
    RAISE EXCEPTION 'graph_message_id column missing — aborting migration 102.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'graph_internet_message_id'
  ) THEN
    RAISE EXCEPTION 'graph_internet_message_id column missing — aborting migration 102.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'graph_conversation_id'
  ) THEN
    RAISE EXCEPTION 'graph_conversation_id column missing — aborting migration 102.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_support_ticket_messages'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_support_ticket_messages not created — aborting migration 102.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_support_ticket_messages_direction_chk'
  ) THEN
    RAISE EXCEPTION 'direction CHECK constraint missing — aborting migration 102.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_support_poll_state'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_support_poll_state not created — aborting migration 102.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'idx_support_tickets_graph_conversation_id'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'idx_support_tickets_graph_conversation_id missing — aborting migration 102.';
  END IF;
  RAISE NOTICE '102_support_thread_linking: 3 columns + 2 tables + 3 indexes + 1 check constraint created.';
END $$;

COMMIT;

-- Migration 135 — Pending tool-action confirmations
--
-- Phase 3 of the agentic-executor work introduces action tools: tools
-- that MUTATE state (save a fact, draft an email, create a calendar
-- event). Every action tool's first dispatch returns `needs_confirmation`
-- so we never silently mutate. The user's next turn must explicitly
-- confirm before the handler runs.
--
-- This table holds the "I want to do X, waiting for your OK" state:
--   - one row per pending action
--   - 5-minute expiry so abandoned actions auto-clear
--   - consumed_at + consumed_by capture the audit trail when the user
--     does confirm — gives us a queryable record of every executed
--     mutation without a separate audit table for action tools (the
--     existing audit-log records the EXECUTION on top of this).

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_pending_actions (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT         NOT NULL,
  tool_name     TEXT         NOT NULL,
  params        JSONB        NOT NULL,
  description   TEXT         NOT NULL,
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL DEFAULT (now() + interval '5 minutes'),
  consumed_at   TIMESTAMPTZ,
  consumed_by   TEXT,
  consumed_via  TEXT
    CONSTRAINT pending_actions_consumed_via_check
    CHECK (consumed_via IS NULL OR consumed_via IN ('confirm', 'cancel', 'expired'))
);

-- The hot lookup: "most recent pending action for this user that's
-- still alive and unconsumed." Partial index keeps it tiny.
CREATE INDEX IF NOT EXISTS idx_pending_actions_user_alive
  ON instinct_pending_actions (user_id, created_at DESC)
  WHERE consumed_at IS NULL;

-- Used by the cron / lazy-cleanup path to mark expired rows.
CREATE INDEX IF NOT EXISTS idx_pending_actions_expiring
  ON instinct_pending_actions (expires_at)
  WHERE consumed_at IS NULL;

COMMIT;

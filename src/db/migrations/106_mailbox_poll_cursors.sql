-- 106_mailbox_poll_cursors.sql — per-base mailbox cursor table.
--
-- Replaces the synthetic-string cursor key trick in inbox-poller.ts. The
-- previous implementation overloaded the existing
-- `instinct_automation_porsche_poll_state.user_id` column with values like
-- "<userId>::<mailboxBase>" so a single (automation_id, user_id) row could
-- hold multiple cursors when AUTOMATION_POLL_MAILBOX_UPNS spans more than
-- one mailbox. That worked but is not normalized: you can't query by
-- mailbox_base, can't index it, can't JOIN on it cleanly. This migration
-- adds a proper composite-key table.
--
-- Schema:
--   PRIMARY KEY        — UUID id (so rows have a stable handle in audit logs)
--   automation_id      — TEXT slug from registry (porsche-classes, meeting-insights)
--   user_id            — TEXT (matches the existing _poll_state.user_id type
--                        which stores either a UUID-shaped string or an upn
--                        like "homyk@thewolfpack.agency"; we keep the same
--                        widening so existing rows backfill cleanly)
--   mailbox_base       — TEXT, '' for the legacy default mailbox
--   delta_link         — TEXT, the actual cursor (Graph deltaLink OR
--                        "search:<iso>" for search-mode polls)
--   last_polled_at     — TIMESTAMPTZ for stalled-mailbox detection
--   UNIQUE             — (automation_id, user_id, mailbox_base)
--
-- Backfill: rows are populated from the existing
-- `instinct_automation_porsche_poll_state` table. Synthetic keys
-- "<userId>::<base>" are split into (user_id=userId, mailbox_base=base);
-- plain keys (no "::") become (user_id=key, mailbox_base=''). The legacy
-- table is preserved so the new code path can still fall back to it for
-- one release window — see inbox-poller.ts comment "TODO(2026-Q3): remove
-- legacy delta_link fallback after 2026-06-01."
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on table + indexes (re-runnable on partial applies).
--   * Backfill uses INSERT ... SELECT ... ON CONFLICT DO NOTHING so the
--     migration is idempotent — re-running won't duplicate rows or clobber
--     newer cursors written after the first apply.
--   * Final DO block ASSERTs the table + both indexes exist.
--   * Down migration drops in reverse order with IF EXISTS everywhere.
--
-- RLS: not used here. Convention in this repo (see migrations 077-105 —
-- none enable RLS) is to enforce auth + tenant scoping at the API layer
-- via `requireCapability` + explicit user_id parameters. Keeping this
-- migration consistent with that pattern.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- mailbox_poll_cursors
-- ============================================================
CREATE TABLE IF NOT EXISTS mailbox_poll_cursors (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   TEXT NOT NULL,
  user_id         TEXT NOT NULL,
  mailbox_base    TEXT NOT NULL,
  delta_link      TEXT,
  last_polled_at  TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_mailbox_poll_cursors_composite
    UNIQUE (automation_id, user_id, mailbox_base)
);

-- Hot-path lookup helpers.
--
-- Query patterns:
--   1. Per-poll cursor read keyed by (automation_id, user_id, mailbox_base)
--      — already covered by the UNIQUE composite index. No extra index
--      needed for the primary access path.
--   2. "list all cursors for a user" (used by the diag page that shows
--      every mailbox state for debugging) — covered by idx_user.
--   3. "find every cursor for a mailbox base across users" (used when
--      auditing whether all polled mailboxes are healthy) — covered by
--      idx_base.
CREATE INDEX IF NOT EXISTS idx_mailbox_poll_cursors_user
  ON mailbox_poll_cursors (user_id);

CREATE INDEX IF NOT EXISTS idx_mailbox_poll_cursors_base
  ON mailbox_poll_cursors (mailbox_base);

-- ============================================================
-- Backfill from the legacy single-cursor table.
-- ============================================================
-- The synthetic-key trick: rows whose user_id contains "::" were storing
-- a (real_user_id, mailbox_base) pair. Split them. Rows without "::" map
-- to (user_id, '') — empty string represents the legacy default mailbox.
-- ON CONFLICT DO NOTHING so re-running the migration is safe and won't
-- clobber cursors written by the new code path after the first apply.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_automation_porsche_poll_state'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    INSERT INTO mailbox_poll_cursors
      (automation_id, user_id, mailbox_base, delta_link, last_polled_at, created_at, updated_at)
    SELECT
      automation_id,
      CASE
        WHEN user_id LIKE '%::%'
          THEN split_part(user_id, '::', 1)
        ELSE user_id
      END                                                AS user_id,
      CASE
        WHEN user_id LIKE '%::%'
          THEN substring(user_id FROM position('::' IN user_id) + 2)
        ELSE ''
      END                                                AS mailbox_base,
      delta_link,
      last_polled_at,
      COALESCE(created_at, NOW())                        AS created_at,
      COALESCE(updated_at, NOW())                        AS updated_at
    FROM instinct_automation_porsche_poll_state
    ON CONFLICT (automation_id, user_id, mailbox_base) DO NOTHING;

    RAISE NOTICE '106_mailbox_poll_cursors: backfilled from instinct_automation_porsche_poll_state.';
  ELSE
    RAISE NOTICE '106_mailbox_poll_cursors: legacy table not present, skipping backfill.';
  END IF;
END $$;

-- ============================================================
-- Structure assertions (per memory feedback_migration_safety)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'mailbox_poll_cursors'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'mailbox_poll_cursors not created — aborting migration 106.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_mailbox_poll_cursors_user'
  ) THEN
    RAISE EXCEPTION 'idx_mailbox_poll_cursors_user missing — aborting migration 106.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_mailbox_poll_cursors_base'
  ) THEN
    RAISE EXCEPTION 'idx_mailbox_poll_cursors_base missing — aborting migration 106.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'uq_mailbox_poll_cursors_composite'
  ) THEN
    RAISE EXCEPTION 'uq_mailbox_poll_cursors_composite missing — aborting migration 106.';
  END IF;
  RAISE NOTICE '106_mailbox_poll_cursors: 1 table + 2 indexes + 1 unique constraint created.';
END $$;

COMMIT;

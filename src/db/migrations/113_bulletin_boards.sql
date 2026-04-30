-- 113_bulletin_boards.sql — Multi-user bulletin boards (Wolfpack-wide).
--
-- Three-table design:
--   instinct_bulletin_boards      — one row per board (title, description,
--                                   audit owner, optional archived snapshot
--                                   timestamp). Boards are org-shared:
--                                   every Wolfpack member sees every board;
--                                   `owner_user_id` is recorded for audit
--                                   only and is NOT used to scope reads.
--   instinct_bulletin_notes       — one row per sticky note (body, color,
--                                   percentage-based position + size,
--                                   optional cross-surface association).
--                                   Soft-deleted via `deleted_at`.
--   instinct_bulletin_snapshots   — one row per "frozen" PNG of a board
--                                   (kept inline as BYTEA — boards are
--                                   small enough that blob storage is
--                                   overkill at the agency scale we run).
--
-- Defensive guards: BEGIN/COMMIT, IF NOT EXISTS on every object, final
-- ASSERT block validating column shape, paired .down.sql with reverse-
-- order drops.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_bulletin_boards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  /* Org-shared by default. owner_user_id is recorded for audit but
     NOT used to scope reads — every Wolfpack member sees every board. */
  owner_user_id TEXT,
  owner_user_role TEXT,
  /* When the board was "frozen" as a meeting artifact. NULL = still
     editable; non-NULL = read-only snapshot. */
  archived_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulletin_boards_created
  ON instinct_bulletin_boards (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bulletin_boards_active
  ON instinct_bulletin_boards (created_at DESC)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS instinct_bulletin_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES instinct_bulletin_boards(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  /* Hex or named color, default #ffeb3b (sticky-note yellow). */
  color TEXT NOT NULL DEFAULT '#ffeb3b',
  /* Position + size as percentages 0..100 of the board so the layout
     stays correct across viewport sizes. */
  x_pct NUMERIC(6,2) NOT NULL DEFAULT 10,
  y_pct NUMERIC(6,2) NOT NULL DEFAULT 10,
  width_pct NUMERIC(6,2) NOT NULL DEFAULT 18,
  height_pct NUMERIC(6,2) NOT NULL DEFAULT 14,
  rotation_deg NUMERIC(6,2) NOT NULL DEFAULT 0,
  /* Optional association — which other Instinct entity this note is
     tied to. `kind` is one of: task, goal, meeting, discussion,
     calendar_event. `id` is the foreign id (free text — we don't FK
     across tables because targets live in different schemas). */
  association_kind TEXT CHECK (association_kind IS NULL OR association_kind IN
    ('task','goal','meeting','discussion','calendar_event')),
  association_id TEXT,
  association_label TEXT,
  created_by_user_id TEXT NOT NULL,
  created_by_user_role TEXT,
  created_by_user_name TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_bulletin_notes_board_active
  ON instinct_bulletin_notes (board_id, created_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_bulletin_notes_assoc
  ON instinct_bulletin_notes (association_kind, association_id)
  WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS instinct_bulletin_snapshots (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  board_id UUID NOT NULL REFERENCES instinct_bulletin_boards(id) ON DELETE CASCADE,
  /* PNG bytes inline. Boards are small (a few KB to a few hundred KB),
     no need for blob storage at this scale. */
  png_bytes BYTEA NOT NULL,
  /* Optional association (same shape as notes). When set, the snapshot
     becomes a meeting artifact / task attachment / etc. */
  association_kind TEXT CHECK (association_kind IS NULL OR association_kind IN
    ('task','goal','meeting','discussion','calendar_event')),
  association_id TEXT,
  association_label TEXT,
  created_by_user_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_bulletin_snapshots_board
  ON instinct_bulletin_snapshots (board_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_bulletin_snapshots_assoc
  ON instinct_bulletin_snapshots (association_kind, association_id);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_bulletin_boards'
  ) >= 7, 'instinct_bulletin_boards missing expected columns';
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_bulletin_notes'
  ) >= 17, 'instinct_bulletin_notes missing expected columns';
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_bulletin_snapshots'
  ) >= 8, 'instinct_bulletin_snapshots missing expected columns';
END $$;

COMMIT;

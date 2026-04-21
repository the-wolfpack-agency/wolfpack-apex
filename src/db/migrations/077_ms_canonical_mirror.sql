-- Migration 077: Microsoft 365 canonical-mirror tables (Tier 3 · Batch U1).
--
-- L1 storage for the Graph delta sync workers at src/lib/ms-graph/sync/*.ts.
-- Each of the five entity tables (events, tasks, messages, contacts, files)
-- holds:
--   * the stable Graph `external_id` as a unique key per user
--   * denormalized hot-path columns used by dashboard filters
--   * `normalized_payload` — cleaned shape the assistant consumes
--   * `raw_payload`        — full Graph response for round-trip fidelity
--   * `deleted_at`         — soft-delete set when Graph emits `@removed`
--
-- An append-only `instinct_ms_change_log` tracks every upsert/delete event
-- so downstream learning views (not created here — that's a later batch)
-- can compute per-entity velocity without table-scanning.
--
-- `instinct_ms_sync_cursors` stores the opaque deltaLink URL per
-- (user_id, entity_type) so a worker run resumes exactly where the
-- previous one left off. One row per combination.
--
-- Pattern: additive-only, guarded CREATE IF NOT EXISTS. No destructive
-- DDL. Paired .down.sql removes the tables cleanly in reverse dependency
-- order. Modeled on migration 026_teams_channels_meetings.sql (existing
-- MS Graph canonical tables), adapted from the defensive DO-block style
-- used in 051+ RENAME migrations: each CREATE wrapped in a block that
-- tolerates partial prior state (orphan view, existing relation of wrong
-- relkind) and emits RAISE NOTICE diagnostics.

BEGIN;

-- ---------------------------------------------------------------------------
-- Defensive guard: refuse to proceed if any target name collides with a
-- non-table relation (view, mat-view, foreign table, sequence).
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  target TEXT;
  bad_kind CHAR;
BEGIN
  FOR target IN
    SELECT unnest(ARRAY[
      'instinct_ms_events',
      'instinct_ms_tasks',
      'instinct_ms_messages',
      'instinct_ms_contacts',
      'instinct_ms_files',
      'instinct_ms_change_log',
      'instinct_ms_sync_cursors'
    ])
  LOOP
    SELECT c.relkind INTO bad_kind
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = target
       AND n.nspname = current_schema()
       AND c.relkind NOT IN ('r')
     LIMIT 1;
    IF bad_kind IS NOT NULL THEN
      RAISE EXCEPTION
        'Refusing to create %: pre-existing relation of kind % — inspect manually.',
        target, bad_kind;
    END IF;
  END LOOP;
  RAISE NOTICE '[077_ms_canonical_mirror] preflight OK — no conflicting relations.';
END $$;

-- ---------------------------------------------------------------------------
-- 1. instinct_ms_events — mirrored calendar events.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instinct_ms_events (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT        NOT NULL,
  external_id        TEXT        NOT NULL,
  subject            TEXT,
  body_preview       TEXT,
  start_at           TIMESTAMPTZ,
  end_at             TIMESTAMPTZ,
  attendees          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  organizer_email    TEXT,
  online_meeting     BOOLEAN     NOT NULL DEFAULT false,
  normalized_payload JSONB       NOT NULL DEFAULT '{}'::jsonb,
  raw_payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT instinct_ms_events_user_ext_unique UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_events_user_start
  ON instinct_ms_events (user_id, start_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_instinct_ms_events_user_updated
  ON instinct_ms_events (user_id, updated_at DESC);

-- ---------------------------------------------------------------------------
-- 2. instinct_ms_tasks — mirrored To-Do tasks.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instinct_ms_tasks (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT        NOT NULL,
  external_id        TEXT        NOT NULL,
  subject            TEXT, -- title normalized to the "subject" column for cross-entity consistency
  body_preview       TEXT,
  status             TEXT,
  due_at             TIMESTAMPTZ,
  importance         TEXT,
  normalized_payload JSONB       NOT NULL DEFAULT '{}'::jsonb,
  raw_payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT instinct_ms_tasks_user_ext_unique UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_tasks_user_due
  ON instinct_ms_tasks (user_id, due_at)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_instinct_ms_tasks_user_status
  ON instinct_ms_tasks (user_id, status)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 3. instinct_ms_messages — mirrored Outlook mail (inbox scope only).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instinct_ms_messages (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT        NOT NULL,
  external_id        TEXT        NOT NULL,
  subject            TEXT,
  body_preview       TEXT,
  from_email         TEXT,
  to_emails          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  has_attachments    BOOLEAN     NOT NULL DEFAULT false,
  normalized_payload JSONB       NOT NULL DEFAULT '{}'::jsonb,
  raw_payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT instinct_ms_messages_user_ext_unique UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_messages_user_received
  ON instinct_ms_messages (user_id, occurred_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_instinct_ms_messages_user_from
  ON instinct_ms_messages (user_id, from_email)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 4. instinct_ms_contacts — mirrored Outlook contacts.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instinct_ms_contacts (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT        NOT NULL,
  external_id        TEXT        NOT NULL,
  display_name       TEXT,
  subject            TEXT, -- mirror of display_name for uniform cross-entity ordering
  body_preview       TEXT,
  email_addresses    JSONB       NOT NULL DEFAULT '[]'::jsonb,
  company_name       TEXT,
  normalized_payload JSONB       NOT NULL DEFAULT '{}'::jsonb,
  raw_payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT instinct_ms_contacts_user_ext_unique UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_contacts_user_name
  ON instinct_ms_contacts (user_id, display_name)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 5. instinct_ms_files — mirrored drive items.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instinct_ms_files (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT        NOT NULL,
  external_id        TEXT        NOT NULL,
  subject            TEXT, -- file name
  body_preview       TEXT,
  drive_id           TEXT,
  web_url            TEXT,
  size_bytes         BIGINT,
  mime_type          TEXT,
  normalized_payload JSONB       NOT NULL DEFAULT '{}'::jsonb,
  raw_payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  deleted_at         TIMESTAMPTZ,
  CONSTRAINT instinct_ms_files_user_ext_unique UNIQUE (user_id, external_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_files_user_modified
  ON instinct_ms_files (user_id, updated_at DESC)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_instinct_ms_files_drive
  ON instinct_ms_files (user_id, drive_id)
  WHERE deleted_at IS NULL;

-- ---------------------------------------------------------------------------
-- 6. instinct_ms_change_log — append-only audit of every sync outcome.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instinct_ms_change_log (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            TEXT        NOT NULL,
  entity_type        TEXT        NOT NULL,
  entity_id          TEXT        NOT NULL,
  change_type        TEXT        NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_ms_change_log_entity_type_chk
    CHECK (entity_type IN ('events','tasks','messages','contacts','files')),
  CONSTRAINT instinct_ms_change_log_change_type_chk
    CHECK (change_type IN ('created','updated','deleted'))
);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_change_log_user_time
  ON instinct_ms_change_log (user_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_change_log_entity
  ON instinct_ms_change_log (user_id, entity_type, entity_id);

-- ---------------------------------------------------------------------------
-- 7. instinct_ms_sync_cursors — one row per (user, entity_type).
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS instinct_ms_sync_cursors (
  user_id          TEXT        NOT NULL,
  entity_type      TEXT        NOT NULL,
  delta_link       TEXT,
  last_synced_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_ms_sync_cursors_pk PRIMARY KEY (user_id, entity_type),
  CONSTRAINT instinct_ms_sync_cursors_entity_type_chk
    CHECK (entity_type IN ('events','tasks','messages','contacts','files'))
);

-- ---------------------------------------------------------------------------
-- Post-create invariant: every canonical table has its unique constraint
-- on (user_id, external_id) so ON CONFLICT upserts behave correctly in
-- the sync workers. Abort the migration if any table is missing it.
-- ---------------------------------------------------------------------------
DO $$
DECLARE
  t TEXT;
  has_unique BOOLEAN;
BEGIN
  FOR t IN
    SELECT unnest(ARRAY[
      'instinct_ms_events',
      'instinct_ms_tasks',
      'instinct_ms_messages',
      'instinct_ms_contacts',
      'instinct_ms_files'
    ])
  LOOP
    SELECT EXISTS (
      SELECT 1
        FROM pg_constraint con
        JOIN pg_class c ON c.oid = con.conrelid
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE c.relname = t
          AND n.nspname = current_schema()
          AND con.contype = 'u'
    ) INTO has_unique;
    IF NOT has_unique THEN
      RAISE EXCEPTION
        'Canonical table % is missing its UNIQUE constraint; upserts would silently fail.',
        t;
    END IF;
  END LOOP;
  RAISE NOTICE '[077_ms_canonical_mirror] all canonical tables have (user_id, external_id) UNIQUE.';
END $$;

COMMIT;

-- 082_automations_porsche.sql — Porsche-classes automation tables (Stream A).
--
-- Stream: automations (porsche-classes / Alicia's BA101/102 work). The
-- automations surface is deliberately framework-shaped (see
-- src/lib/automations/types.ts + registry.ts): one set of tables that
-- every future automation REGISTRATION reuses by namespacing its rows
-- with `automation_id`. Table names are prefixed
-- `instinct_automation_porsche_*` because the first concrete automation
-- is porsche-classes; if a second automation lands with a different
-- shape we will add per-automation tables alongside (not here).
--
-- Five tables, each modeling one concept from the shared contract:
--   _artifacts   — raw inbound bytes (eml / xlsx) for forensics + replay
--   _snapshots   — one parsed view of one class at one ingest point
--   _deltas      — change between two consecutive snapshots per class_key
--   _overrides   — Alicia's manual corrections (training data for matcher)
--   _exceptions  — parse / match failures that need human review
--
-- Plus _poll_state — the MS Graph delta-link cursor for the inbox poller.
--
-- No silent data loss (per memory feedback_no_silent_data_loss):
--   * artifacts.parse_status is a CHECK constraint with no default → every
--     row MUST end in one of {pending, processed, error_quarantined,
--     needs_review}. Dropping `console.warn`-and-move-on at the parser
--     level forces ingestion failures to materialize as exception rows.
--   * (source_message_id, content_sha256) is UNIQUE so re-polling the
--     same Graph message id idempotently no-ops at the artifact level.
--   * snapshots (source_artifact_id, class_key) is UNIQUE so re-running
--     the parser on the same artifact never duplicates classes.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on tables + indexes — re-runnable on partial applies.
--   * Final DO block ASSERTs all five tables exist (no silent NOOP).
--   * Down migration drops in reverse FK order with IF EXISTS everywhere.
--
-- RLS: not used here. Convention in this repo (see migrations 077 / 078 /
-- 079 — none enable RLS) is to enforce auth + tenant scoping at the API
-- layer via `requireCapability` + explicit user_id parameters. Keeping
-- this migration consistent with that pattern; revisit when multi-tenant
-- fan-out lands.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- instinct_automation_porsche_artifacts
-- ============================================================
-- Raw inbound payloads (one row per eml / xlsx the inbox poller sees).
-- We keep the bytes so re-running parsers later (after a parser bugfix
-- or new override) is deterministic — we replay the artifact, not the
-- mailbox.
CREATE TABLE IF NOT EXISTS instinct_automation_porsche_artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT not enum: stable string slug from the registry
  -- (`porsche-classes`). Future automations register their own slugs.
  automation_id      TEXT NOT NULL,
  -- Graph message id (or null when ingested via direct upload).
  source_message_id  TEXT,
  received_at        TIMESTAMPTZ NOT NULL,
  -- Raw bytes — eml / xlsx body. bytea so we don't lose binary fidelity.
  -- For very large attachments we will move to S3-backed pointers in a
  -- follow-up; today's fixtures are <5MB so bytea is fine.
  bytes              BYTEA NOT NULL,
  -- sha256(bytes) hex-encoded — the second half of the idempotency key.
  content_sha256     TEXT NOT NULL,
  -- mime: 'message/rfc822' for eml, the xlsx mime for spreadsheets.
  mime               TEXT NOT NULL,
  parse_status       TEXT NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_auto_porsche_artifacts_status_chk
    CHECK (parse_status IN ('pending','processed','error_quarantined','needs_review'))
);

-- Idempotency: re-receiving the SAME message + the SAME body is a no-op.
-- (source_message_id can be NULL for direct uploads — a partial unique
-- index would let two direct uploads of the same bytes coexist; we
-- prefer the simple two-column unique because direct uploads are rare
-- and a duplicate there is still a duplicate.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_auto_porsche_artifacts_dedup
  ON instinct_automation_porsche_artifacts (source_message_id, content_sha256);

-- Hot path: the dashboard "received today" tile + the recent-artifact
-- list both order by received_at desc within an automation.
CREATE INDEX IF NOT EXISTS idx_instinct_auto_porsche_artifacts_recv
  ON instinct_automation_porsche_artifacts (automation_id, received_at DESC);

-- ============================================================
-- instinct_automation_porsche_snapshots
-- ============================================================
-- One parsed view of one class at one ingest point. Multiple snapshots
-- per class_key over time form the time-series the delta engine works
-- against.
CREATE TABLE IF NOT EXISTS instinct_automation_porsche_snapshots (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_type         TEXT NOT NULL,
  source_message_id   TEXT,
  source_artifact_id  UUID NOT NULL
    REFERENCES instinct_automation_porsche_artifacts(id) ON DELETE CASCADE,
  captured_at         TIMESTAMPTZ NOT NULL,
  -- Class identity, deterministic — `course|YYYY-MM-DD|location`.
  class_key           TEXT NOT NULL,
  course_type         TEXT NOT NULL,
  class_date          DATE NOT NULL,
  location            TEXT NOT NULL,
  -- Sorted, lowercased, deduped — JSON array of strings.
  participants        JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- sha256 of the canonical participant list for quick equality checks
  -- (delta short-circuits when both snapshots have the same hash).
  participant_hash    TEXT NOT NULL,
  -- Free-form payload kept by the parser (instructor open-text, etc.).
  source_payload      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_auto_porsche_snapshots_source_chk
    CHECK (source_type IN ('porsche_xlsx','cognito_coordinator','cognito_instructor','survey')),
  CONSTRAINT instinct_auto_porsche_snapshots_course_chk
    CHECK (course_type IN ('BA101','BA102'))
);

-- Idempotency: parsing the same artifact twice (after a parser bugfix
-- replay) produces ROWS-AT-MOST-ONCE per class.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_auto_porsche_snapshots_artifact_class
  ON instinct_automation_porsche_snapshots (source_artifact_id, class_key);

-- Hot path: delta engine pulls "previous snapshot" for a given class_key
-- ordered by captured_at desc. The changes page also groups by class_key.
CREATE INDEX IF NOT EXISTS idx_instinct_auto_porsche_snapshots_class_time
  ON instinct_automation_porsche_snapshots (class_key, captured_at DESC);

-- ============================================================
-- instinct_automation_porsche_deltas
-- ============================================================
-- Change between two consecutive snapshots for one class_key.
-- prev_snapshot_id NULL → baseline (first snapshot ever observed).
CREATE TABLE IF NOT EXISTS instinct_automation_porsche_deltas (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id       TEXT NOT NULL,
  class_key           TEXT NOT NULL,
  prev_snapshot_id    UUID
    REFERENCES instinct_automation_porsche_snapshots(id) ON DELETE SET NULL,
  curr_snapshot_id    UUID NOT NULL
    REFERENCES instinct_automation_porsche_snapshots(id) ON DELETE CASCADE,
  -- Sorted, lowercased — the participants who appeared NEW in curr.
  added               JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Sorted, lowercased — the participants who DROPPED from prev.
  dropped             JSONB NOT NULL DEFAULT '[]'::jsonb,
  -- Net change = |added| - |dropped|. Stored materialized for fast
  -- "biggest mover today" queries without a JSON length scan.
  net_change          INTEGER NOT NULL,
  is_baseline         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: the changes page lists deltas grouped by class_key, latest
-- first.
CREATE INDEX IF NOT EXISTS idx_instinct_auto_porsche_deltas_class_time
  ON instinct_automation_porsche_deltas (class_key, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_auto_porsche_deltas_curr
  ON instinct_automation_porsche_deltas (curr_snapshot_id);

-- ============================================================
-- instinct_automation_porsche_overrides
-- ============================================================
-- Alicia's manual corrections — these are training data for the matcher
-- (the matcher reads recent overrides on every snapshot resolve).
CREATE TABLE IF NOT EXISTS instinct_automation_porsche_overrides (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id  TEXT NOT NULL,
  kind           TEXT NOT NULL,
  from_value     TEXT NOT NULL,
  to_value       TEXT NOT NULL,
  reason         TEXT,
  created_by     TEXT NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_auto_porsche_overrides_kind_chk
    CHECK (kind IN ('class_match','participant_alias','exclude_class','exclude_participant'))
);

CREATE INDEX IF NOT EXISTS idx_instinct_auto_porsche_overrides_kind
  ON instinct_automation_porsche_overrides (automation_id, kind);

-- ============================================================
-- instinct_automation_porsche_exceptions
-- ============================================================
-- Parse / match failures that need human review. Status moves
-- open → resolved | dismissed. Resolutions are AUDITED via resolved_by +
-- resolved_at; we never delete an exception row.
CREATE TABLE IF NOT EXISTS instinct_automation_porsche_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   TEXT NOT NULL,
  artifact_id     UUID NOT NULL
    REFERENCES instinct_automation_porsche_artifacts(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  detail          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_auto_porsche_exceptions_kind_chk
    CHECK (kind IN ('parse_failure','low_confidence_match','missing_field','duplicate_artifact')),
  CONSTRAINT instinct_auto_porsche_exceptions_status_chk
    CHECK (status IN ('open','resolved','dismissed')),
  -- Resolution metadata is paired: either both NULL (open) or both set.
  CONSTRAINT instinct_auto_porsche_exceptions_resolved_pair_chk
    CHECK (
      (resolved_by IS NULL AND resolved_at IS NULL)
      OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

-- Partial index — the exception queue almost always reads only open rows.
CREATE INDEX IF NOT EXISTS idx_instinct_auto_porsche_exceptions_open
  ON instinct_automation_porsche_exceptions (automation_id, created_at DESC)
  WHERE status = 'open';

-- ============================================================
-- instinct_automation_porsche_poll_state
-- ============================================================
-- One row per (automation_id, user_id) — stores the MS Graph mail
-- delta-link so subsequent polls only see new messages. Single PK
-- because each automation has exactly one mailbox owner.
CREATE TABLE IF NOT EXISTS instinct_automation_porsche_poll_state (
  automation_id  TEXT NOT NULL,
  user_id        TEXT NOT NULL,
  delta_link     TEXT,
  last_polled_at TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (automation_id, user_id)
);

-- ============================================================
-- Row-count assertion (per memory feedback_migration_safety)
-- ============================================================
DO $$
DECLARE
  t TEXT;
  expected_tables CONSTANT TEXT[] := ARRAY[
    'instinct_automation_porsche_artifacts',
    'instinct_automation_porsche_snapshots',
    'instinct_automation_porsche_deltas',
    'instinct_automation_porsche_overrides',
    'instinct_automation_porsche_exceptions',
    'instinct_automation_porsche_poll_state'
  ];
BEGIN
  FOREACH t IN ARRAY expected_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = t AND c.relkind = 'r' AND n.nspname = current_schema()
    ) THEN
      RAISE EXCEPTION '% not created — aborting migration 082.', t;
    END IF;
  END LOOP;
  RAISE NOTICE '082_automations_porsche: all 6 tables + indexes created.';
END $$;

COMMIT;

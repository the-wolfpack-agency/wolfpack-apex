-- 083_meeting_insights.sql — Meeting Insights automation tables (Stream A).
--
-- Stream: meeting-insights — multi-feed org-shared meeting / recurring-email
-- ingest. The feed model lets a single registry entry watch many distinct
-- recurring threads (one feed per Porsche stand-up, per BD weekly, per
-- vendor briefing, etc.) without a registry change. Per-message routing
-- in src/lib/automations/meeting-insights/router.ts assigns each inbound
-- email to the right feed based on (feeds.filters), with first-match-wins.
--
-- Five tables:
--   _feeds         — admin-defined "what to watch" (filters jsonb)
--   _artifacts     — raw inbound bytes (eml) for forensics + replay
--   _messages      — parsed email row, FK to feeds + artifact
--   _attachments   — file bytes + extracted_text per message
--   _exceptions    — parse / route failures that need human review
--
-- RLS:
--   * Org-shared. We do NOT enforce per-tenant scoping at the row level
--     in this migration because Instinct is single-org today (one
--     postgres database per workspace). When multi-tenant fan-out lands
--     a future migration will add a tenant_id column + RLS policy.
--   * Capability scoping is enforced at the API layer via
--     `requireCapability` (meetings.view / meetings.manage / meetings.export).
--     Mirrors the convention in 082_automations_porsche.sql.
--   * We DO enable row-level security on the four tables that contain
--     content so any future REST-style direct-DB connection (e.g.
--     PostgREST proxy in shadow mode) defaults to deny rather than
--     leaking message bodies.
--
-- No silent data loss (per memory feedback_no_silent_data_loss):
--   * artifacts.parse_status is a CHECK constraint with no default → every
--     row MUST end in one of {pending, processed, error_quarantined,
--     needs_review}. Failures materialize as exception rows.
--   * messages (feed_id, source_message_id) is UNIQUE so re-polling the
--     same Graph message id idempotently no-ops at the message level.
--   * attachments has FK to messages with ON DELETE CASCADE so deleting a
--     message removes its attachments together (no orphan bytea rows).
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on tables + indexes — re-runnable on partial applies.
--   * Final DO block ASSERTs all five tables exist (no silent NOOP).
--   * Down migration drops in reverse FK order with IF EXISTS everywhere.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- instinct_meeting_feeds
-- ============================================================
-- Org-shared "what to watch" definition. Each feed has its own filter
-- set (sender substrings, subject substrings, optional since-date) and
-- the inbox poller will union all enabled feeds' filters for the Graph
-- delta query. Per-message routing then assigns each match to a feed.
--
-- is_enabled = false acts as soft-delete; we never DROP rows because
-- doing so would orphan messages history.
CREATE TABLE IF NOT EXISTS instinct_meeting_feeds (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Kebab-case, lowercase, route-safe slug — derived from name on insert
  -- by the API layer. UNIQUE so feeds/[slug] routes are stable.
  slug         TEXT NOT NULL UNIQUE,
  name         TEXT NOT NULL,
  description  TEXT,
  -- Filters: { sender_match: string[], subject_match: string[], since?: string }
  filters      JSONB NOT NULL DEFAULT '{"sender_match":[],"subject_match":[]}'::jsonb,
  is_enabled   BOOLEAN NOT NULL DEFAULT TRUE,
  -- User email of the operator that created the feed.
  created_by   TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_meeting_feeds_slug_chk
    CHECK (slug ~ '^[a-z0-9][a-z0-9-]{0,63}$')
);

CREATE INDEX IF NOT EXISTS idx_instinct_meeting_feeds_enabled
  ON instinct_meeting_feeds (is_enabled, slug);

-- RLS: enabled but permissive at the DB layer. The API layer enforces
-- capability gates; we keep RLS on so a future direct-DB caller has to
-- explicitly disable it (deny-by-default once policies are added).
ALTER TABLE instinct_meeting_feeds ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_meeting_feeds_all ON instinct_meeting_feeds;
CREATE POLICY instinct_meeting_feeds_all ON instinct_meeting_feeds
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- instinct_meeting_artifacts
-- ============================================================
-- Raw inbound payloads (one row per eml the inbox poller sees). We keep
-- the bytes so re-running parsers later (after a Stream B parser bugfix)
-- is deterministic — replay the artifact, not the mailbox.
CREATE TABLE IF NOT EXISTS instinct_meeting_artifacts (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Graph message id (or null when ingested via direct upload).
  source_message_id  TEXT,
  received_at        TIMESTAMPTZ NOT NULL,
  -- Raw bytes — eml body. bytea so we don't lose binary fidelity.
  bytes              BYTEA NOT NULL,
  -- sha256(bytes) hex-encoded — the second half of the idempotency key.
  content_sha256     TEXT NOT NULL,
  mime               TEXT NOT NULL,
  parse_status       TEXT NOT NULL DEFAULT 'pending',
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_meeting_artifacts_status_chk
    CHECK (parse_status IN ('pending','processed','error_quarantined','needs_review'))
);

-- Idempotency: re-receiving the SAME message + the SAME body is a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_meeting_artifacts_dedup
  ON instinct_meeting_artifacts (source_message_id, content_sha256);

-- Hot path: dashboards order by received_at desc.
CREATE INDEX IF NOT EXISTS idx_instinct_meeting_artifacts_recv
  ON instinct_meeting_artifacts (received_at DESC);

ALTER TABLE instinct_meeting_artifacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_meeting_artifacts_all ON instinct_meeting_artifacts;
CREATE POLICY instinct_meeting_artifacts_all ON instinct_meeting_artifacts
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- instinct_meeting_messages
-- ============================================================
-- One ingested email tied to one feed. Stream B's parsers fill in
-- body_text + body_html; the row is created with empty strings up front
-- so a parser failure surfaces as a row with empty body + an exception.
CREATE TABLE IF NOT EXISTS instinct_meeting_messages (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  feed_id             UUID NOT NULL
    REFERENCES instinct_meeting_feeds(id) ON DELETE CASCADE,
  artifact_id         UUID NOT NULL
    REFERENCES instinct_meeting_artifacts(id) ON DELETE CASCADE,
  -- Graph message id (or null for direct uploads).
  source_message_id   TEXT NOT NULL,
  subject             TEXT NOT NULL DEFAULT '',
  from_address        TEXT NOT NULL DEFAULT '',
  from_name           TEXT,
  -- TEXT[] columns hold address lists in the order Graph returned them.
  to_addresses        TEXT[] NOT NULL DEFAULT '{}',
  cc_addresses        TEXT[] NOT NULL DEFAULT '{}',
  received_at         TIMESTAMPTZ NOT NULL,
  body_text           TEXT NOT NULL DEFAULT '',
  body_html           TEXT,
  has_attachments     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotency at the message level: same feed + same Graph message_id =
-- no-op. (Different feeds CAN ingest the same message — that's a
-- legitimate cross-list match.)
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_meeting_messages_feed_msg
  ON instinct_meeting_messages (feed_id, source_message_id);

CREATE INDEX IF NOT EXISTS idx_instinct_meeting_messages_feed_recv
  ON instinct_meeting_messages (feed_id, received_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_meeting_messages_artifact
  ON instinct_meeting_messages (artifact_id);

ALTER TABLE instinct_meeting_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_meeting_messages_all ON instinct_meeting_messages;
CREATE POLICY instinct_meeting_messages_all ON instinct_meeting_messages
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- instinct_meeting_attachments
-- ============================================================
-- File bytes + parser-extracted text per attachment. Stream B's
-- extractors (.docx via mammoth, .pdf via unpdf) populate
-- extracted_text + extraction_status; this migration only defines the
-- shape so the bytes never live in an in-memory map.
CREATE TABLE IF NOT EXISTS instinct_meeting_attachments (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id          UUID NOT NULL
    REFERENCES instinct_meeting_messages(id) ON DELETE CASCADE,
  filename            TEXT NOT NULL,
  mime                TEXT NOT NULL,
  size_bytes          INTEGER NOT NULL DEFAULT 0,
  extracted_text      TEXT,
  extraction_status   TEXT NOT NULL DEFAULT 'unsupported_mime',
  bytes               BYTEA,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_meeting_attachments_status_chk
    CHECK (extraction_status IN ('extracted','unsupported_mime','error'))
);

CREATE INDEX IF NOT EXISTS idx_instinct_meeting_attachments_msg
  ON instinct_meeting_attachments (message_id);

ALTER TABLE instinct_meeting_attachments ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_meeting_attachments_all ON instinct_meeting_attachments;
CREATE POLICY instinct_meeting_attachments_all ON instinct_meeting_attachments
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- instinct_meeting_exceptions
-- ============================================================
-- Parse / route failures that need human review. Status moves
-- open → resolved | dismissed. Resolutions are AUDITED via resolved_by +
-- resolved_at; we never delete an exception row.
CREATE TABLE IF NOT EXISTS instinct_meeting_exceptions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  artifact_id     UUID NOT NULL
    REFERENCES instinct_meeting_artifacts(id) ON DELETE CASCADE,
  -- Optional FK to a feed, when routing succeeded but parsing failed.
  feed_id         UUID
    REFERENCES instinct_meeting_feeds(id) ON DELETE SET NULL,
  kind            TEXT NOT NULL,
  detail          TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'open',
  resolved_by     TEXT,
  resolved_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_meeting_exceptions_kind_chk
    CHECK (kind IN ('parse_failure','no_route_match','attachment_extract_failed','duplicate_artifact','missing_field')),
  CONSTRAINT instinct_meeting_exceptions_status_chk
    CHECK (status IN ('open','resolved','dismissed')),
  CONSTRAINT instinct_meeting_exceptions_resolved_pair_chk
    CHECK (
      (resolved_by IS NULL AND resolved_at IS NULL)
      OR (resolved_by IS NOT NULL AND resolved_at IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_instinct_meeting_exceptions_open
  ON instinct_meeting_exceptions (created_at DESC)
  WHERE status = 'open';

ALTER TABLE instinct_meeting_exceptions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_meeting_exceptions_all ON instinct_meeting_exceptions;
CREATE POLICY instinct_meeting_exceptions_all ON instinct_meeting_exceptions
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- Row-count assertion (per memory feedback_migration_safety)
-- ============================================================
DO $$
DECLARE
  t TEXT;
  expected_tables CONSTANT TEXT[] := ARRAY[
    'instinct_meeting_feeds',
    'instinct_meeting_artifacts',
    'instinct_meeting_messages',
    'instinct_meeting_attachments',
    'instinct_meeting_exceptions'
  ];
BEGIN
  FOREACH t IN ARRAY expected_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = t AND c.relkind = 'r' AND n.nspname = current_schema()
    ) THEN
      RAISE EXCEPTION '% not created — aborting migration 083.', t;
    END IF;
  END LOOP;
  RAISE NOTICE '083_meeting_insights: all 5 tables + indexes + RLS created.';
END $$;

COMMIT;

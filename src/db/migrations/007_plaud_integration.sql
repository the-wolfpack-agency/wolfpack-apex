-- Plaud (AI voice recorder) integration.
--
-- Stores org-level Plaud connection (one shared API key for the team)
-- and ingested meeting transcripts. Transcripts are shared across the
-- whole team, but every row records owner_user_id so we can switch to
-- per-user scoped retrieval later without re-ingesting anything.
--
-- Webhook design (from Plaud docs):
--   POST {our endpoint}
--   Header: Plaud-Signature  (HMAC-SHA256 of raw body using PLAUD_WEBHOOK_SECRET)
--   Body:   { event_type: "audio_transcribe.completed", data: { file_id, ... } }
-- We must be idempotent — Plaud may re-deliver the same event.

-- 1. Org-level Plaud connection (singleton row).
--    api_key is stored as text — secrets handling lives at the env layer
--    (PLAUD_API_KEY in Vercel). This row tracks WHO connected and WHEN
--    so we have an audit trail.
CREATE TABLE IF NOT EXISTS apex_plaud_connections (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  scope         TEXT         NOT NULL DEFAULT 'org',  -- 'org' today, 'user' future
  connected_by  TEXT         NOT NULL,                 -- apex_team_members.id
  display_name  TEXT,
  connected_at  TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apex_plaud_connections_scope
  ON apex_plaud_connections (scope);

-- 2. Meeting transcripts (the actual data).
--    file_id is Plaud's identifier — the unique index makes the
--    webhook idempotent: re-delivery upserts instead of duplicating.
CREATE TABLE IF NOT EXISTS apex_meeting_transcripts (
  id              TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  file_id         TEXT         NOT NULL,                 -- Plaud's file id
  owner_user_id   TEXT         NOT NULL,                 -- whose meeting it is
  title           TEXT,
  transcript_text TEXT         NOT NULL,
  summary         TEXT,
  recorded_at     TIMESTAMPTZ,
  duration_seconds INTEGER,
  source          TEXT         NOT NULL DEFAULT 'plaud',
  quality_status  TEXT         NOT NULL DEFAULT 'pass'   -- pass | warn | reject
                              CHECK (quality_status IN ('pass', 'warn', 'reject')),
  quality_flags   JSONB        DEFAULT '[]',
  ingested_at     TIMESTAMPTZ  DEFAULT NOW(),
  metadata        JSONB        DEFAULT '{}'
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apex_meeting_transcripts_file_id
  ON apex_meeting_transcripts (file_id);
CREATE INDEX IF NOT EXISTS idx_apex_meeting_transcripts_owner
  ON apex_meeting_transcripts (owner_user_id);
CREATE INDEX IF NOT EXISTS idx_apex_meeting_transcripts_recorded_at
  ON apex_meeting_transcripts (recorded_at DESC);

-- 3. Learning view: meeting ingestion quality over time, per user.
--    Feeds the analytics page so we can see ingestion health and which
--    team members are contributing the most meeting context.
CREATE OR REPLACE VIEW apex_v_meeting_ingestion_quality AS
SELECT
  owner_user_id,
  COUNT(*)                                                    AS total_transcripts,
  SUM(CASE WHEN quality_status = 'pass'   THEN 1 ELSE 0 END)  AS passed,
  SUM(CASE WHEN quality_status = 'warn'   THEN 1 ELSE 0 END)  AS warned,
  SUM(CASE WHEN quality_status = 'reject' THEN 1 ELSE 0 END)  AS rejected,
  MAX(ingested_at)                                            AS last_ingest_at,
  AVG(duration_seconds)::INTEGER                              AS avg_duration_seconds
FROM apex_meeting_transcripts
GROUP BY owner_user_id;

-- 084_meeting_analysis.sql — Meeting Insights Phase 2: per-message LLM analyses.
--
-- Stream: meeting-insights — Phase 2 + 3.
-- Builds the analysis layer on top of 083_meeting_insights.sql. Every ingested
-- meeting message gets a structured analysis snapshot (decisions, action items,
-- topics, attendees, blockers, next steps) keyed by analyzer_version so we can
-- re-run with newer prompts without losing history.
--
-- Triple-write: Postgres is the canonical store; the application layer mirrors
-- the analysis text to Qdrant for semantic search and Neo4j for the
-- (:Message)-[:DISCUSSED]->(:Topic) graph used by the cross-meeting theme
-- tracker (Phase 3, src/lib/automations/meeting-insights/themes.ts).
--
-- Idempotency:
--   * UNIQUE (message_id, analyzer_version) — re-analyzing the same message
--     with the same prompt version is a no-op (UPSERT on update).
--   * Bumping analyzer_version creates a new row, preserving prior history.
--
-- No silent data loss (per memory feedback_no_silent_data_loss):
--   * status is a CHECK constraint (success | partial | error). Every
--     analyzer call MUST land a row, even on parse failure (status='partial')
--     or an SDK/credential error (status='error'). raw_llm_response is
--     persisted so we can retry from disk later.
--   * error_detail surfaces actionable info (missing env var, network failure,
--     schema violation) into the dashboard.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on tables + indexes — re-runnable on partial applies.
--   * Final DO block ASSERTs the table + key index exist.
--   * Down migration drops in reverse FK order with IF EXISTS everywhere.

BEGIN;

-- ============================================================
-- instinct_meeting_analyses
-- ============================================================
-- One analysis snapshot per (message, analyzer_version). The structured
-- fields are jsonb (so we can grow the schema) plus a denormalized
-- topics text[] for fast GIN-indexed theme search.
CREATE TABLE IF NOT EXISTS instinct_meeting_analyses (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id         UUID NOT NULL
    REFERENCES instinct_meeting_messages(id) ON DELETE CASCADE,

  -- Bump when the prompt or schema changes. Lets us re-analyze without
  -- losing history. Format: 'YYYY-MM-DD.N' or semver — opaque to DB.
  analyzer_version   TEXT NOT NULL,
  analyzed_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Structured outputs from the LLM. JSONB so we can evolve the schema
  -- without a migration each time.
  --
  -- decisions: [{ summary, rationale?, owners?, source_quote? }]
  -- action_items: [{ description, owner?, due?, completed?, source_quote? }]
  -- attendees: [{ name?, email?, role? }]
  -- blockers: [{ description, severity? }]
  -- next_steps: [{ description, when? }]
  decisions          JSONB NOT NULL DEFAULT '[]'::jsonb,
  action_items       JSONB NOT NULL DEFAULT '[]'::jsonb,
  attendees          JSONB NOT NULL DEFAULT '[]'::jsonb,
  blockers           JSONB NOT NULL DEFAULT '[]'::jsonb,
  next_steps         JSONB NOT NULL DEFAULT '[]'::jsonb,

  -- Denormalized topic strings, lowercased + trimmed by the analyzer.
  -- A separate text[] (rather than jsonb) so we can build a GIN index
  -- and run array containment / overlap queries from the theme tracker.
  topics             TEXT[] NOT NULL DEFAULT '{}',

  -- Forensic / replay fields. raw_llm_response is the full text the
  -- model returned (post-cache, pre-parse) so we can re-extract from
  -- disk if our parser regresses.
  raw_llm_response   TEXT,
  model              TEXT,
  tokens_used        INTEGER,

  status             TEXT NOT NULL DEFAULT 'success',
  error_detail       TEXT,

  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT instinct_meeting_analyses_status_chk
    CHECK (status IN ('success','partial','error'))
);

-- Idempotency: same (message, analyzer_version) is a no-op on UPSERT.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_meeting_analyses_msg_ver
  ON instinct_meeting_analyses (message_id, analyzer_version);

CREATE INDEX IF NOT EXISTS idx_instinct_meeting_analyses_msg
  ON instinct_meeting_analyses (message_id);

-- GIN on topics for the theme tracker — supports `topics && ARRAY[...]`
-- (overlap) and `topics @> ARRAY[...]` (contains). Hot path for
-- recurringTopics / staleTopics queries in themes.ts.
CREATE INDEX IF NOT EXISTS idx_instinct_meeting_analyses_topics_gin
  ON instinct_meeting_analyses USING GIN (topics);

-- For "latest analysis per message" queries.
CREATE INDEX IF NOT EXISTS idx_instinct_meeting_analyses_msg_latest
  ON instinct_meeting_analyses (message_id, analyzed_at DESC);

ALTER TABLE instinct_meeting_analyses ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_meeting_analyses_all ON instinct_meeting_analyses;
CREATE POLICY instinct_meeting_analyses_all ON instinct_meeting_analyses
  FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- Row-count assertion (per memory feedback_migration_safety)
-- ============================================================
DO $$
DECLARE
  expected_indexes CONSTANT TEXT[] := ARRAY[
    'uq_instinct_meeting_analyses_msg_ver',
    'idx_instinct_meeting_analyses_topics_gin'
  ];
  ix TEXT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_meeting_analyses'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_meeting_analyses not created — aborting migration 084.';
  END IF;
  FOREACH ix IN ARRAY expected_indexes LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = ix AND c.relkind = 'i' AND n.nspname = current_schema()
    ) THEN
      RAISE EXCEPTION 'index % not created — aborting migration 084.', ix;
    END IF;
  END LOOP;
  RAISE NOTICE '084_meeting_analysis: instinct_meeting_analyses + indexes created.';
END $$;

COMMIT;

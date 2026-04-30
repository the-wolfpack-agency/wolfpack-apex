-- 108_knowledge_qa_cache.sql — semantic Q&A cache for /knowledge + /assistant.
--
-- Goal: every previously-answered question — internal-doc, AI-generated,
-- or human-curated — is reused before we burn tokens calling the LLM
-- again. Two surfaces consume this table:
--
--   1. /knowledge — search box + "Ask a Question" panel. AI fallback when
--      the cache misses, then the answer joins the cache for everyone.
--   2. /assistant — "Support" mode pill. The wolfpack can self-serve
--      common support questions before submitting a ticket.
--
-- Why a NEW table instead of bolting onto instinct_knowledge:
--   * instinct_knowledge models curated Q&A entries (rated, tagged,
--     view-counted) with their own UI lifecycle. This cache is
--     question-keyed (normalized + embedded) and tracks lookup hit-rate
--     + helpful counters tuned for the LLM-fallback flow. Different
--     access patterns, different invariants — separate table, separate
--     indexes.
--   * Auto-flagging: the cache lib retires rows whose
--     not_helpful_count > 5 AND helpful_count = 0. instinct_knowledge
--     does not currently expose that signal in the UI.
--
-- pgvector availability:
--   This deploy does not currently install the pgvector extension (no
--   prior migration enables it). Storing the question_embedding as JSONB
--   so the lookup helper can compute cosine similarity in JS. Migration
--   to a real `vector(1536)` column is a follow-up — the lib's lookup
--   path is the only consumer, so swapping the storage type is a
--   one-file change once pgvector is provisioned.
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

CREATE TABLE IF NOT EXISTS knowledge_qa_entries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Original verbatim question as the user typed it. Preserved so the
  -- /knowledge page can render the question label users will recognize
  -- in their own search history.
  question_text TEXT NOT NULL,
  -- Lowercased, whitespace-collapsed, trailing-punctuation-stripped form
  -- of question_text. Used as the EXACT-MATCH FAST PATH before the
  -- vector lookup so two users typing "How do I reset my password?" and
  -- "how do i reset my password" hit the same row in O(1) DB time.
  question_normalized TEXT NOT NULL,
  -- The question's embedding. Stored as JSONB pending pgvector rollout.
  -- Schema: { dim: number, model: string, vector: number[] } or null
  -- when no embedding key is configured (the lookup helper falls back
  -- to word-overlap scoring against question_normalized in that case).
  question_embedding JSONB,
  -- The answer the user sees. Markdown is permitted.
  answer_text TEXT NOT NULL,
  -- Provenance.
  --   ai_generated   — LLM produced the answer; ai_model + ai_generated_at set.
  --   internal_doc   — sourced from a curated brain doc / runbook.
  --   human_curated  — a wolfpack member typed the answer themselves.
  source TEXT NOT NULL CHECK (source IN ('ai_generated','internal_doc','human_curated')),
  -- Model name when source = 'ai_generated', e.g. 'anthropic/claude-haiku-4.5'.
  ai_model TEXT,
  ai_generated_at TIMESTAMPTZ,
  -- Which surface(s) this answer is valid for. 'both' lets one row cover
  -- a question relevant to /knowledge and /assistant simultaneously.
  surface TEXT NOT NULL CHECK (surface IN ('knowledge','assistant_support','both')),
  -- Quality counters surfaced via /api/knowledge/feedback. The lookup
  -- helper auto-flags a row for review when not_helpful_count > 5 AND
  -- helpful_count = 0.
  helpful_count INTEGER NOT NULL DEFAULT 0,
  not_helpful_count INTEGER NOT NULL DEFAULT 0,
  -- Cache-hit telemetry. Every hit bumps lookup_count + last_used_at;
  -- the analytics dashboard reads them to compute the cache-hit ratio.
  lookup_count INTEGER NOT NULL DEFAULT 0,
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The user who first triggered the row's creation. Stored as TEXT to
  -- match the rest of the codebase (TeamMember.id is a string).
  created_by_user_id TEXT
);

-- Hot-path lookup: every cache check filters by question_normalized.
CREATE INDEX IF NOT EXISTS idx_qa_normalized
  ON knowledge_qa_entries (question_normalized);

-- Surface filter: /assistant support-mode lookups exclude knowledge-only
-- rows and vice versa. The lookup helper applies surface IN (...) to
-- the WHERE clause; this index keeps that scan fast.
CREATE INDEX IF NOT EXISTS idx_qa_surface
  ON knowledge_qa_entries (surface);

-- Auto-flag scan: an analytics view (and a future eviction job) reads
-- (not_helpful_count, helpful_count) to find rows that should be
-- demoted. Index keeps the scan cheap.
CREATE INDEX IF NOT EXISTS idx_qa_quality_signal
  ON knowledge_qa_entries (not_helpful_count, helpful_count);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'knowledge_qa_entries'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'knowledge_qa_entries not created — aborting migration 108.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_qa_normalized'
  ) THEN
    RAISE EXCEPTION 'idx_qa_normalized missing — aborting migration 108.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_qa_surface'
  ) THEN
    RAISE EXCEPTION 'idx_qa_surface missing — aborting migration 108.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes WHERE indexname = 'idx_qa_quality_signal'
  ) THEN
    RAISE EXCEPTION 'idx_qa_quality_signal missing — aborting migration 108.';
  END IF;
  RAISE NOTICE '108_knowledge_qa_cache: 1 table + 3 indexes created.';
END $$;

COMMIT;

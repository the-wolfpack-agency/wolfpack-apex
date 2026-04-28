-- 105_support_response_cache.sql — persistent AI response cache for support.
--
-- Goal: every previously-generated AI solution is reused instead of
-- regenerated. Tokens spent once on novel work; everything similar after
-- that is free forever (Nick's invariant: tokens for novel work, codified
-- tooling for everything seen before).
--
-- Two surfaces in this migration:
--
-- 1. instinct_support_response_cache — new table. One row per (feature,
--    lexical_signature). The `cached_response` JSONB carries the full
--    AICompleteResponse-shaped payload so future hits can return without
--    calling the provider. Quality counters (helpful_count /
--    unhelpful_count) gate "good cache hits": rows whose unhelpful balance
--    exceeds helpful are NOT served by the lookup helper, so a bad cached
--    response stops poisoning future requests after the operator votes.
--
-- 2. instinct_support_tickets.cache_ids — new JSONB column. Records which
--    cache rows powered which AI feature on this ticket, so when an
--    operator votes helpful/unhelpful in the feedback handler we can
--    propagate that signal back to the cache rows that produced the draft.
--
-- Auto-decay: rows with last_used_at > 90 days ago are eligible for a
-- vacuum job. Out of scope this migration; future migration / cron will
-- delete or downgrade them. The hit_count + last_used_at index here is
-- what the eviction pass reads.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on the table + indexes + ALTER COLUMN.
--   * Final DO block ASSERTs structure.
--   * Down migration drops in reverse order with IF EXISTS.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- instinct_support_response_cache
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_support_response_cache (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Which AI feature: 'support.draft' | 'support.categorize' |
  -- 'support.auto_ack'. Kept as TEXT (not enum) so future features can
  -- start writing without a migration.
  feature TEXT NOT NULL,
  -- sha256 of normalized input (lowercased, whitespace-collapsed,
  -- stripped of names/UUIDs/timestamps/phones/emails). Two tickets that
  -- describe the same conceptual issue — even with different names and
  -- timestamps — collide on this signature so the second ticket reuses
  -- the first ticket's cached response.
  lexical_signature TEXT NOT NULL,
  -- Qdrant point id for the embedding of the input. Nullable when Qdrant
  -- was unavailable at write time. Reserved for the Phase 2 semantic
  -- fallback path (out of scope this PR — the response-cache.ts helper
  -- only does lexical match for now).
  semantic_vector_id TEXT,
  -- The input that was hashed. Useful for debugging cache collisions and
  -- for the Phase 2 path to re-embed if semantic_vector_id is null.
  prompt_input JSONB NOT NULL,
  -- The AI's output, JSONB-shaped to mirror AICompleteResponse so future
  -- hits can return it as if the provider had just answered.
  cached_response JSONB NOT NULL,
  -- Provenance. model_used + provider_used at the time the row was
  -- written; future hits surface 'cache' for provider but the original
  -- model + provider are preserved for analytics.
  model_used TEXT NOT NULL,
  provider_used TEXT NOT NULL,
  -- Running tally of tokens NOT spent because of this cache hit. Updated
  -- on every hit (input_tokens + output_tokens of the cached response,
  -- per hit). Lets the analytics dashboard show a "we saved X tokens
  -- this week" headline metric.
  tokens_saved_estimate INT NOT NULL DEFAULT 0,
  -- Hit counters.
  hit_count INT NOT NULL DEFAULT 0,
  -- Operator-facing quality counters. Incremented by the feedback
  -- handler when the operator marks a ticket helpful/unhelpful and the
  -- ticket recorded a cache_id for the relevant feature.
  helpful_count INT NOT NULL DEFAULT 0,
  unhelpful_count INT NOT NULL DEFAULT 0,
  -- Last time this row was served as a cache hit. NULL until first hit;
  -- the eviction job uses this column.
  last_used_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot-path lookup: every cache check filters by feature +
-- lexical_signature. UNIQUE on (feature, lexical_signature) so the
-- writer can use ON CONFLICT to bump hit_count instead of inserting a
-- duplicate row.
CREATE UNIQUE INDEX IF NOT EXISTS idx_support_response_cache_feature_sig
  ON instinct_support_response_cache (feature, lexical_signature);

-- Eviction job reads (last_used_at) DESC NULLS LAST to find stale rows.
CREATE INDEX IF NOT EXISTS idx_support_response_cache_last_used
  ON instinct_support_response_cache (last_used_at);

-- ============================================================
-- instinct_support_tickets.cache_ids — JSONB column linking each ticket
-- to the cache rows that powered its AI features. Shape:
--   {
--     "draft": "<uuid>",
--     "categorize": "<uuid>",
--     "auto_ack": "<uuid>"
--   }
-- Any subset of those keys may be present. Used by the feedback handler
-- so when an operator votes helpful/unhelpful we can propagate to the
-- exact cache rows that produced the answer.
-- ============================================================
ALTER TABLE instinct_support_tickets
  ADD COLUMN IF NOT EXISTS cache_ids JSONB NOT NULL DEFAULT '{}'::jsonb;

-- ============================================================
-- Structure assertions (per memory feedback_migration_safety)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_support_response_cache'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_support_response_cache not created — aborting migration 105.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'instinct_support_tickets'
      AND column_name = 'cache_ids'
  ) THEN
    RAISE EXCEPTION 'instinct_support_tickets.cache_ids column missing — aborting migration 105.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_support_response_cache_feature_sig'
  ) THEN
    RAISE EXCEPTION 'idx_support_response_cache_feature_sig missing — aborting migration 105.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'idx_support_response_cache_last_used'
  ) THEN
    RAISE EXCEPTION 'idx_support_response_cache_last_used missing — aborting migration 105.';
  END IF;
  RAISE NOTICE '105_support_response_cache: 1 table + 2 indexes + 1 column created.';
END $$;

COMMIT;

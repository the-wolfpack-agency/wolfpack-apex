-- 116_principles.sql — operating-principles platform tables.
--
-- Hoxsie + Nick's SharePoint operating-principles doc becomes the
-- source-of-truth for behavioral observation across the M365 + Azure
-- stack. This migration adds the 4 tables that store parsed principles,
-- their typed signals, the per-observation evidence rail, and the
-- doc-version history for change-detect on the sync job.
--
-- Tables:
--   instinct_principles            — one row per principle (current + retired)
--   instinct_principle_signals     — one row per Signal/Counter-signal
--                                    (ties principle prose to validator ids)
--   instinct_principle_observations — one row per evaluation result with evidence
--   instinct_principle_doc_versions — change-detect history for the input doc
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT.
--   * IF NOT EXISTS guards on every table + index.
--   * Final structural assertion DO block.
--   * Paired .down.sql.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- instinct_principles — one row per principle, one row per version.
-- The newest row per slug is the active principle. Retiring sets
-- retired_at and inserts a new row when the principle is replaced
-- so we keep history for audit + scoreboard time-travel.
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_principles (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug              TEXT NOT NULL,
  title             TEXT NOT NULL,
  domains           TEXT[] NOT NULL DEFAULT '{}',
  owner             TEXT,
  body_md           TEXT NOT NULL DEFAULT '',
  scoreboard_weight INTEGER NOT NULL DEFAULT 1
                    CHECK (scoreboard_weight BETWEEN 1 AND 5),
  source_url        TEXT,
  source_doc_hash   TEXT,
  effective_at      DATE,
  retired_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Hot path: fetch the active principle for a given slug.
CREATE INDEX IF NOT EXISTS idx_principles_slug_active
  ON instinct_principles (slug)
  WHERE retired_at IS NULL;

-- Listing surface: active principles in display order.
CREATE INDEX IF NOT EXISTS idx_principles_active_created
  ON instinct_principles (created_at DESC)
  WHERE retired_at IS NULL;

-- ============================================================
-- instinct_principle_signals — one row per Signal / Counter-signal
-- line in the doc. validator_id links to a code-defined evaluator
-- (registry in src/lib/principles/validators.ts).
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_principle_signals (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principle_id  UUID NOT NULL REFERENCES instinct_principles(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL CHECK (kind IN ('signal', 'counter')),
  description   TEXT NOT NULL,
  validator_id  TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_principle_signals_principle
  ON instinct_principle_signals (principle_id);

-- Validator-id index supports the cron job querying "all signals for
-- validator calendar.focus_block_ratio" to batch-evaluate.
CREATE INDEX IF NOT EXISTS idx_principle_signals_validator
  ON instinct_principle_signals (validator_id)
  WHERE validator_id IS NOT NULL;

-- ============================================================
-- instinct_principle_observations — one row per evaluation result.
-- evidence_jsonb is uniform across all surfaces (kind, source_id,
-- source_url, subject_user_id, metric, captured_at) so the scoreboard
-- can drill in regardless of source.
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_principle_observations (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  principle_id    UUID NOT NULL REFERENCES instinct_principles(id) ON DELETE CASCADE,
  signal_id       UUID REFERENCES instinct_principle_signals(id) ON DELETE SET NULL,
  validator_id    TEXT NOT NULL,
  surface         TEXT NOT NULL,
  surface_subtype TEXT,
  subject_user_id TEXT,
  observed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- score in -1..1 — negative = drift from principle, positive =
  -- adherence. The scoreboard sums weighted scores.
  score           NUMERIC(4, 3) NOT NULL CHECK (score BETWEEN -1 AND 1),
  evidence_jsonb  JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_principle_observations_principle_observed
  ON instinct_principle_observations (principle_id, observed_at DESC);

CREATE INDEX IF NOT EXISTS idx_principle_observations_subject_observed
  ON instinct_principle_observations (subject_user_id, observed_at DESC)
  WHERE subject_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_principle_observations_validator_observed
  ON instinct_principle_observations (validator_id, observed_at DESC);

-- ============================================================
-- instinct_principle_doc_versions — change-detect history for the
-- input SharePoint doc. The cron job fetches the doc, hashes it,
-- inserts a new row only when the hash changes, then re-syncs
-- principles + signals from the new content.
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_principle_doc_versions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_url             TEXT NOT NULL,
  doc_hash               TEXT NOT NULL,
  fetched_at             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parsed_principle_count INTEGER NOT NULL DEFAULT 0,
  parse_warnings_jsonb   JSONB NOT NULL DEFAULT '[]'::jsonb,
  triggered_by           TEXT NOT NULL DEFAULT 'cron'
                         CHECK (triggered_by IN ('cron', 'manual'))
);

CREATE INDEX IF NOT EXISTS idx_principle_doc_versions_source_fetched
  ON instinct_principle_doc_versions (source_url, fetched_at DESC);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.tables
     WHERE table_name IN (
       'instinct_principles',
       'instinct_principle_signals',
       'instinct_principle_observations',
       'instinct_principle_doc_versions'
     )
  ) = 4, 'principles platform: missing one of the 4 expected tables';
END $$;

COMMIT;

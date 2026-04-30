-- 109_org_facts.sql — org-wide learning facts captured from user corrections.
--
-- Goal: when a wolfpack member corrects an assistant answer ("no, the
-- client is Porsche, not TWA"), we capture that as a structured fact
-- and inject it back into future LLM prompts. The assistant gets
-- smarter every time anyone corrects it, no engineer required.
--
-- Shape:
--   subject     — the thing the fact is about (free text; we match by
--                 case-insensitive substring against question/answer).
--   attribute   — what aspect of the subject the fact describes
--                 ("client", "owner", "status", "due_date", …).
--                 Free text so the system can capture novel attributes
--                 without a schema change.
--   value       — the corrected value the user supplied.
--   superseded_by — when a later correction overrides this one, we
--                 link forward instead of deleting; full history is
--                 always recoverable.
--
-- Why a new table instead of stuffing this into instinct_knowledge:
--   * Different access pattern: facts are looked up by SUBJECT for
--     prompt augmentation, not searched as Q&A.
--   * Different lifecycle: facts age with helpful/contradicted votes,
--     not with cache TTLs.
--   * Different content: structured (subject, attribute, value), not
--     prose answers.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on the table + indexes.
--   * Final DO block ASSERTs structure.
--   * Paired .down.sql drops in reverse with IF EXISTS.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_org_facts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subject TEXT NOT NULL,
  subject_normalized TEXT NOT NULL,
  attribute TEXT NOT NULL,
  value TEXT NOT NULL,
  source_message_id TEXT,
  source_user_id TEXT,
  source_user_role TEXT,
  /* Confidence/feedback. Each row starts at 1 helpful (the user who
     supplied it implicitly endorses it). */
  helpful_count INT NOT NULL DEFAULT 1,
  contradicted_count INT NOT NULL DEFAULT 0,
  superseded_by UUID REFERENCES instinct_org_facts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_org_facts_subject_normalized
  ON instinct_org_facts (subject_normalized);

CREATE INDEX IF NOT EXISTS idx_org_facts_attribute
  ON instinct_org_facts (attribute);

CREATE INDEX IF NOT EXISTS idx_org_facts_active
  ON instinct_org_facts (subject_normalized)
  WHERE superseded_by IS NULL;

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*)
      FROM information_schema.columns
     WHERE table_name = 'instinct_org_facts'
       AND column_name IN (
         'id','subject','subject_normalized','attribute','value',
         'source_message_id','source_user_id','source_user_role',
         'helpful_count','contradicted_count','superseded_by',
         'created_at','last_used_at'
       )
  ) = 13, 'instinct_org_facts missing expected columns';
END $$;

COMMIT;

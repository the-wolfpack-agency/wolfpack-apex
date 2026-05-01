-- 114_email_signatures_body_format.sql — distinguish text vs HTML signatures.
--
-- Wolfpack uses animated/HTML signatures (logo image, social icons,
-- formatted contact block). Migration 111 stored the body as TEXT but
-- the composer treated it as plain text and ran it through
-- plainTextToHtml at insert time, which destroyed every <img>, link, and
-- inline style. This migration adds an explicit `body_format` column so
-- the composer knows when to insert raw HTML and when to convert plain
-- text. Existing rows default to 'text' (the only thing that could have
-- been stored before this migration).
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT.
--   * IF NOT EXISTS / DO-block guards on every alter.
--   * Final assertion that the column + constraint exist.
--   * Paired .down.sql drops in reverse with IF EXISTS.

BEGIN;

ALTER TABLE instinct_email_signatures
  ADD COLUMN IF NOT EXISTS body_format TEXT NOT NULL DEFAULT 'text';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'instinct_email_signatures_body_format_chk'
  ) THEN
    ALTER TABLE instinct_email_signatures
      ADD CONSTRAINT instinct_email_signatures_body_format_chk
      CHECK (body_format IN ('text', 'html'));
  END IF;
END $$;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'instinct_email_signatures'
       AND column_name = 'body_format'
  ) THEN
    RAISE EXCEPTION '114_email_signatures_body_format: body_format column missing — aborting.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'instinct_email_signatures_body_format_chk'
  ) THEN
    RAISE EXCEPTION '114_email_signatures_body_format: check constraint missing — aborting.';
  END IF;
  RAISE NOTICE '114_email_signatures_body_format: body_format column + check constraint added (idempotent).';
END $$;

COMMIT;

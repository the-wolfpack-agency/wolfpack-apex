-- Migration 150 — preserve every workbook column on the job-codes cache.
--
-- The 149 parser only captured Code + Description because that's all the
-- v1 page rendered. CTO 2026-05-21: "where are the rest of [the
-- columns]?" The workbook has more (Project, Client, Rate, etc.) and the
-- mirror dropped them silently.
--
-- `extra` stores every NON-Code/NON-Description column from the workbook
-- as a JSONB blob keyed by the header text. The UI joins this with the
-- top-level code/description for rendering, and the time-entry submit
-- form previews the full record when a code is picked.

BEGIN;

ALTER TABLE instinct_job_codes_cache
  ADD COLUMN IF NOT EXISTS extra JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS ix_instinct_job_codes_extra_gin
  ON instinct_job_codes_cache USING GIN (extra);

COMMIT;

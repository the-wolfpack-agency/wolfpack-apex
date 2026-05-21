-- Migration 157 — persist the workbook's column order on each
-- successful refresh so the UI can render columns in finance's
-- order (not Postgres JSONB's arbitrary key order).
--
-- Bug: Excel showed Client/Category first; Instinct showed it last,
-- because /api/job-codes built `columns` as ["Code","Description",
-- ...Object.keys(extra)] and JSONB keys come back in normalized
-- (not insertion) order. The parser already returns the right
-- order in `parsed.columns`; we just need to persist it.

BEGIN;

ALTER TABLE instinct_job_codes_refresh
  ADD COLUMN IF NOT EXISTS ordered_columns JSONB;

COMMIT;

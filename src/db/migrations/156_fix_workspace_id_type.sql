-- Migration 156 — fix workspace_id type to TEXT on the four tables
-- I added in 151/153/154/155.
--
-- Bug: I declared workspace_id UUID NOT NULL on those tables, but
-- instinct_team_members.workspace_id is TEXT and holds literal
-- strings like "default" (not UUIDs). Result: every GET against the
-- four affected tables 500s with "invalid input syntax for type uuid".
--
-- Safe ALTER: all four tables are empty in prod (the bug prevented
-- any rows from being written). Even with rows present, UUIDs are
-- string-coercible to TEXT so the conversion is non-destructive.

BEGIN;

ALTER TABLE instinct_job_codes_edits ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::text;
ALTER TABLE instinct_receipt_scans ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::text;
ALTER TABLE instinct_invoices ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::text;
ALTER TABLE instinct_hr_scanned_documents ALTER COLUMN workspace_id TYPE TEXT USING workspace_id::text;

COMMIT;

-- Migration 151 — audit log for Instinct-driven edits to the Job Codes
-- SharePoint workbook.
--
-- Every PATCH the cell-edit endpoint sends to MS Graph writes a row
-- here first (atomic with the Graph call). Captures: who edited what
-- cell on what row, what the previous value was, what the new value
-- is, when, and whether the SharePoint mirror succeeded.
--
-- Why DB-side audit even though SharePoint is the financial source of
-- truth: SharePoint's version history doesn't tell us WHO in Instinct
-- triggered the change (the change is recorded against the app-only
-- principal). This table closes that gap so finance can trace every
-- mutation back to the human, and the learning loop can see which
-- columns get edited most.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_job_codes_edits (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    UUID NOT NULL,
  /* Lowercased code so audits join correctly against the cache table's
     UNIQUE LOWER(code) index. */
  code_lower      TEXT NOT NULL,
  /* Display-case code preserved for readability. */
  code            TEXT NOT NULL,
  column_name     TEXT NOT NULL,
  old_value       TEXT,
  new_value       TEXT NOT NULL,
  edited_by       UUID NOT NULL,
  edited_by_email TEXT,
  edited_by_role  TEXT,
  /* succeeded = Graph + DB both accepted. failed = Graph rejected, DB
     row written for the audit trail but the SharePoint cell did NOT
     change. We don't roll back the DB row because the human attempt
     is itself audit-worthy. */
  status          TEXT NOT NULL CHECK (status IN ('succeeded', 'failed')),
  graph_error     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ix_instinct_job_codes_edits_code
  ON instinct_job_codes_edits (code_lower, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_instinct_job_codes_edits_by
  ON instinct_job_codes_edits (edited_by, created_at DESC);

COMMIT;

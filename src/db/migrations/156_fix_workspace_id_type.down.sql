-- Down: revert to UUID. Only safe if every row's workspace_id is
-- actually UUID-shaped; not our case in this workspace.
BEGIN;
ALTER TABLE instinct_hr_scanned_documents ALTER COLUMN workspace_id TYPE UUID USING workspace_id::uuid;
ALTER TABLE instinct_invoices ALTER COLUMN workspace_id TYPE UUID USING workspace_id::uuid;
ALTER TABLE instinct_receipt_scans ALTER COLUMN workspace_id TYPE UUID USING workspace_id::uuid;
ALTER TABLE instinct_job_codes_edits ALTER COLUMN workspace_id TYPE UUID USING workspace_id::uuid;
COMMIT;

BEGIN;
DROP INDEX IF EXISTS ix_instinct_hr_scanned_documents_expiry;
DROP INDEX IF EXISTS ix_instinct_hr_scanned_documents_status;
DROP INDEX IF EXISTS ix_instinct_hr_scanned_documents_employee;
DROP INDEX IF EXISTS uq_instinct_hr_scanned_documents_sha;
DROP TABLE IF EXISTS instinct_hr_scanned_documents;
COMMIT;

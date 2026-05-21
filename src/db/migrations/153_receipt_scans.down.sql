BEGIN;
DROP INDEX IF EXISTS ix_instinct_receipt_scans_code;
DROP INDEX IF EXISTS ix_instinct_receipt_scans_user;
DROP INDEX IF EXISTS uq_instinct_receipt_scans_sha;
DROP TABLE IF EXISTS instinct_receipt_scans;
COMMIT;

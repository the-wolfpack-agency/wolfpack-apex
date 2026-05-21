BEGIN;
DROP INDEX IF EXISTS ix_instinct_invoices_due;
DROP INDEX IF EXISTS ix_instinct_invoices_vendor;
DROP INDEX IF EXISTS ix_instinct_invoices_status;
DROP INDEX IF EXISTS uq_instinct_invoices_sha;
DROP TABLE IF EXISTS instinct_invoices;
COMMIT;

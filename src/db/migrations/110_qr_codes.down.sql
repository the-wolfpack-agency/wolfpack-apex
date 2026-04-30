-- 110_qr_codes.down.sql — reverse 110_qr_codes.sql.
BEGIN;

DROP INDEX IF EXISTS idx_qr_scans_device;
DROP INDEX IF EXISTS idx_qr_scans_country;
DROP INDEX IF EXISTS idx_qr_scans_code_time;
DROP TABLE IF EXISTS instinct_qr_scans;
DROP INDEX IF EXISTS idx_qr_codes_owner;
DROP INDEX IF EXISTS idx_qr_codes_slug;
DROP TABLE IF EXISTS instinct_qr_codes;

COMMIT;

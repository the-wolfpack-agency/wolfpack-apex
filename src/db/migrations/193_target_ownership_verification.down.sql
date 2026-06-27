-- Down for 193_target_ownership_verification.sql
-- Drops the verification state table. Reversible: re-running the up migration
-- recreates an empty table (any prior verifications must be re-proven).

BEGIN;

DROP INDEX IF EXISTS idx_target_verifications_verified;
DROP INDEX IF EXISTS idx_target_verifications_ws_platform;
DROP TABLE IF EXISTS instinct_target_verifications;

COMMIT;

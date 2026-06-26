-- Down for migration 186. Drops the identity index (the de-dup DELETE is not
-- reversible — removed duplicate rows are gone, which is the intended state).
BEGIN;
DROP INDEX IF EXISTS uq_platform_findings_identity;
COMMIT;

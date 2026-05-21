-- Down migration 150 — drop the extra-columns JSONB.
BEGIN;
DROP INDEX IF EXISTS ix_instinct_job_codes_extra_gin;
ALTER TABLE instinct_job_codes_cache DROP COLUMN IF EXISTS extra;
COMMIT;

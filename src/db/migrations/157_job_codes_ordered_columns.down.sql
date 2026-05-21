BEGIN;
ALTER TABLE instinct_job_codes_refresh DROP COLUMN IF EXISTS ordered_columns;
COMMIT;

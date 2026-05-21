BEGIN;
DROP INDEX IF EXISTS ix_instinct_job_codes_edits_by;
DROP INDEX IF EXISTS ix_instinct_job_codes_edits_code;
DROP TABLE IF EXISTS instinct_job_codes_edits;
COMMIT;

-- Down migration 149 — drop job codes cache + refresh log.
-- Safe to run only if no callers still depend on these tables.

BEGIN;
DROP TABLE IF EXISTS instinct_job_codes_refresh;
DROP TABLE IF EXISTS instinct_job_codes_cache;
COMMIT;

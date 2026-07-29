-- Down migration for 223_releases. Idempotent.

BEGIN;

DROP INDEX IF EXISTS idx_instinct_releases_released_on;
DROP INDEX IF EXISTS idx_instinct_releases_version;
DROP TABLE IF EXISTS instinct_releases;

COMMIT;

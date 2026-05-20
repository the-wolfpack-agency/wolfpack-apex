-- Down for migration 146 — drops the time-entries table.
BEGIN;
DROP TABLE IF EXISTS instinct_time_entries;
COMMIT;

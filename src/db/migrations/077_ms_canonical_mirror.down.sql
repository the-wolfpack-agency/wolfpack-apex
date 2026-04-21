-- Migration 077 DOWN: drop MS Graph canonical-mirror tables.
--
-- Reverse of 077_ms_canonical_mirror.sql. Drops in an order that respects
-- the (non-existent here, but future-proof) dependency expectation:
--   change_log + sync_cursors first (metadata), then the five entity
--   mirrors. All DROPs are IF EXISTS so a partial rollback state is
--   tolerated.
--
-- Intentionally destructive. Only run when restoring an older app
-- version that cannot read these tables.

BEGIN;

DROP TABLE IF EXISTS instinct_ms_sync_cursors;
DROP TABLE IF EXISTS instinct_ms_change_log;

DROP TABLE IF EXISTS instinct_ms_files;
DROP TABLE IF EXISTS instinct_ms_contacts;
DROP TABLE IF EXISTS instinct_ms_messages;
DROP TABLE IF EXISTS instinct_ms_tasks;
DROP TABLE IF EXISTS instinct_ms_events;

COMMIT;

-- 112_qr_scans_extended.down.sql — reverse 112_qr_scans_extended.sql.
--
-- Drops the index first, then each extended column. All drops use
-- IF EXISTS so the down migration is idempotent and safe to run even
-- when the up migration only partially applied.
--
-- Note: the base table instinct_qr_scans is owned by migration 110 and
-- is intentionally NOT dropped here — that's 110's job.

BEGIN;

DROP INDEX IF EXISTS idx_qr_scans_visitor;

ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS client_match_score;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS client_id;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS postal_code;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS longitude;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS latitude;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS utm_campaign;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS utm_medium;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS utm_source;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS is_bot;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS screen_size;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS timezone_offset_minutes;
ALTER TABLE instinct_qr_scans DROP COLUMN IF EXISTS language;

COMMIT;

-- Reverses migration 142.

BEGIN;

DROP TABLE IF EXISTS instinct_meeting_prep_signals;
DROP TABLE IF EXISTS instinct_meeting_insights;

COMMIT;

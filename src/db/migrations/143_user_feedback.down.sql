-- Reverses migration 143.

BEGIN;

DROP TABLE IF EXISTS instinct_user_feedback;

COMMIT;

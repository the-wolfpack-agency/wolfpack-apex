-- 114_email_signatures_body_format.down.sql — reverse 114.

BEGIN;

ALTER TABLE instinct_email_signatures
  DROP CONSTRAINT IF EXISTS instinct_email_signatures_body_format_chk;

ALTER TABLE instinct_email_signatures
  DROP COLUMN IF EXISTS body_format;

COMMIT;

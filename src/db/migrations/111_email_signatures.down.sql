-- 111_email_signatures.down.sql — reverse 111_email_signatures.sql.
BEGIN;

DROP INDEX IF EXISTS uq_email_signatures_one_default_per_user;
DROP INDEX IF EXISTS idx_email_signatures_user_default;
DROP TABLE IF EXISTS instinct_email_signatures;

COMMIT;

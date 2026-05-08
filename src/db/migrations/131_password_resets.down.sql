-- 131_password_resets.down.sql — drop the password resets table.
DROP INDEX IF EXISTS idx_password_resets_expires;
DROP INDEX IF EXISTS idx_password_resets_member;
DROP TABLE IF EXISTS instinct_password_resets;

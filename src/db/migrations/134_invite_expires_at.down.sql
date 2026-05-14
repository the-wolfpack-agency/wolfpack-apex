-- Down migration for 134_invite_expires_at.sql
BEGIN;
DROP INDEX IF EXISTS idx_instinct_invites_pending_not_expired;
ALTER TABLE instinct_invites DROP COLUMN IF EXISTS expires_at;
COMMIT;

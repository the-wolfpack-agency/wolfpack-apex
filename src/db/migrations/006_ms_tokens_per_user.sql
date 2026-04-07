-- Make Microsoft tokens truly per-user.
--
-- The original migration (005) made user_email the unique key, which broke
-- multi-user OAuth: the upsert path collided when two users connected the
-- same workspace, and the read path always returned the most recently
-- connected token regardless of who was asking. This migration adds a
-- unique index on connected_by (the team member's apex user_id) so each
-- team member has exactly one row, scoped to themselves.
--
-- We also clean up any rows that were written under the old single-tenant
-- assumption (literal state strings like "apex-ms" or "oauth-callback").
-- Affected users will have to re-OAuth once — acceptable because the
-- integration is days old.

-- 1. Drop orphaned rows that don't correspond to a real apex user.
DELETE FROM apex_ms_tokens
WHERE connected_by NOT IN (SELECT id FROM apex_team_members);

-- 2. Add the per-user unique index. The existing user_email index is kept
--    as a non-unique secondary lookup (an admin tool may want to find a
--    token by mailbox).
DROP INDEX IF EXISTS idx_apex_ms_tokens_email;
CREATE INDEX IF NOT EXISTS idx_apex_ms_tokens_email
  ON apex_ms_tokens (user_email);
CREATE UNIQUE INDEX IF NOT EXISTS idx_apex_ms_tokens_connected_by
  ON apex_ms_tokens (connected_by);

-- 131_password_resets.sql — self-service password reset tokens.
--
-- WHY: Without this table, the CTO is the human bottleneck for every
-- password reset because we don't store reset tokens anywhere. Each
-- reset took ~5 minutes of CTO time + manual hash generation +
-- credential hand-delivery. This migration unblocks the
-- /forgot-password + /reset-password flow.
--
-- Token security model:
--   - We store a SHA-256 hash of the token, not the token itself,
--     so a DB read can't be replayed as an active reset URL.
--   - 15-minute expiry per the security policy decided 2026-05-08.
--   - Single-use: `used_at` flips on successful reset; subsequent
--     posts of the same token return 404.
--   - Foreign key to instinct_team_members ON DELETE CASCADE so a
--     deactivated user can't have a dangling reset token.

CREATE TABLE IF NOT EXISTS instinct_password_resets (
  id              TEXT PRIMARY KEY,
  member_id       TEXT NOT NULL REFERENCES instinct_team_members(id) ON DELETE CASCADE,
  token_sha256    TEXT NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip_address      TEXT,
  user_agent      TEXT
);

CREATE INDEX IF NOT EXISTS idx_password_resets_member ON instinct_password_resets (member_id);
CREATE INDEX IF NOT EXISTS idx_password_resets_expires ON instinct_password_resets (expires_at);

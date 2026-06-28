-- Migration 199 - NextAuth.js / Auth.js credentials connector.
--
-- Why this exists: many client apps (and our own wolfpack-auto) authenticate
-- via NextAuth.js / Auth.js with a credentials provider. That login is neither
-- a static bearer (136), an OAuth2 authorization-code row (138), a simple
-- form-login username/password row (181), nor an OAuth2 resource-owner-password
-- grant (182). It is a CSRF-token-then-callback flow that sets a session-token
-- cookie. The scanner's establishNextAuthSession performs it; this migration
-- lets the credentials be stored.
--
-- Design (mirrors 181/182):
--   - auth_type CHECK is widened to allow 'nextauth_credentials' alongside the
--     existing four. Drop + re-add the named constraint idempotently so re-runs
--     are safe. Without this, INSERTing a nextauth_credentials row is rejected
--     by the CHECK ("Failed to save credentials (DB error)").
--   - NO new columns. credentials.ts Basic-encodes username:password into the
--     existing auth_header_enc column (AES-256-GCM), exactly like
--     username_password; login_path holds the NextAuth callback path
--     (/api/auth/callback/credentials).
--
-- No silent data loss: the CHECK still pins auth_type to a known set; existing
-- rows are unaffected; no schema-shape change beyond the constraint. Down
-- migration restores the 4-value constraint (182's state).

BEGIN;

ALTER TABLE instinct_connector_credentials
  DROP CONSTRAINT IF EXISTS instinct_connector_credentials_auth_type_chk;

ALTER TABLE instinct_connector_credentials
  ADD CONSTRAINT instinct_connector_credentials_auth_type_chk
  CHECK (auth_type IN ('static_bearer','oauth2','username_password','oauth_password','nextauth_credentials'));

COMMENT ON COLUMN instinct_connector_credentials.login_path IS
  'Auth endpoint path. username_password: the form-login path (e.g. /api/auth/login). oauth_password: the OAuth2 token endpoint (e.g. /services/oauth2/token). nextauth_credentials: the NextAuth callback path (e.g. /api/auth/callback/credentials). Null otherwise.';

COMMIT;

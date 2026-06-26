-- Migration 181 — username/password (form-login) connector credentials.
--
-- Why this exists: some client platforms authenticate via a form login
-- (POST /api/auth/login with { username, password }) and return a
-- session cookie, not a static bearer or an OAuth2 access token. Example:
-- wolfpack-beyond's POST /api/auth/login. The connector vault already
-- supports static_bearer (migration 136) and oauth2 (migration 138).
-- This adds a third auth_type: username_password.
--
-- Design (mirrors 138's style):
--   - auth_type CHECK is widened to allow 'username_password' alongside
--     the existing 'static_bearer' and 'oauth2'. Drop + re-add the named
--     constraint idempotently so re-runs are safe.
--   - The credentials.ts layer encodes the username:password pair as a
--     Basic auth header and stores it in the EXISTING auth_header_enc
--     column (AES-256-GCM). No new secret column — the password never
--     lands in plaintext and reuses the encrypted column the loaders
--     already decrypt.
--   - login_path: the form-login endpoint path (e.g. /api/auth/login)
--     the connector POSTs the username/password to.
--   - session_cookie_name: the cookie the platform sets on a successful
--     login (e.g. "session"), so the connector knows which cookie to
--     capture + replay on subsequent requests. Nullable — some platforms
--     return a token body instead of a cookie.
--
-- No silent data loss (per feedback_no_silent_data_loss):
--   * CHECK constraint pins auth_type to the three supported values.
--   * Both new columns nullable so existing rows are unaffected.
--   * Down migration drops the columns + restores the 2-value constraint.

BEGIN;

ALTER TABLE instinct_connector_credentials
  ADD COLUMN IF NOT EXISTS login_path          TEXT,
  ADD COLUMN IF NOT EXISTS session_cookie_name TEXT;

ALTER TABLE instinct_connector_credentials
  DROP CONSTRAINT IF EXISTS instinct_connector_credentials_auth_type_chk;

ALTER TABLE instinct_connector_credentials
  ADD CONSTRAINT instinct_connector_credentials_auth_type_chk
  CHECK (auth_type IN ('static_bearer','oauth2','username_password'));

COMMENT ON COLUMN instinct_connector_credentials.login_path IS
  'Form-login endpoint path the connector POSTs username/password to (e.g. /api/auth/login). Null unless auth_type = username_password.';
COMMENT ON COLUMN instinct_connector_credentials.session_cookie_name IS
  'Session cookie the platform sets on successful form login (e.g. "session"). Null when the platform returns a token body instead of a cookie.';

COMMIT;

-- Migration 182 — OAuth 2.0 Resource Owner Password connector credentials.
--
-- Why this exists: some platforms authenticate via the OAuth 2.0 Resource
-- Owner Password Credentials grant — Salesforce is the canonical example:
-- POST client_id + client_secret + username + password to a token endpoint
-- and receive a bearer access_token + an instance_url. This is neither a
-- static bearer (migration 136), an OAuth2 authorization-code row (migration
-- 138), nor a form-login username/password row (migration 181). It needs all
-- four credential fields exchanged at a token endpoint.
--
-- Design (mirrors 181's style):
--   - auth_type CHECK is widened to allow 'oauth_password' alongside the
--     existing 'static_bearer', 'oauth2', and 'username_password'. Drop +
--     re-add the named constraint idempotently so re-runs are safe.
--   - NO new columns. The credentials.ts layer JSON-encodes the
--     { clientId, clientSecret, username, password } quad and stores it in
--     the EXISTING auth_header_enc column (AES-256-GCM). The secrets never
--     land in plaintext and reuse the encrypted column the loaders already
--     decrypt.
--   - login_path (added in 181) doubles as the token-endpoint path the
--     connector POSTs the credential quad to (e.g. /services/oauth2/token).
--
-- No silent data loss (per feedback_no_silent_data_loss):
--   * CHECK constraint pins auth_type to the four supported values.
--   * No schema-shape change beyond the constraint — existing rows are
--     unaffected.
--   * Down migration restores the 3-value constraint (181's state).

BEGIN;

ALTER TABLE instinct_connector_credentials
  DROP CONSTRAINT IF EXISTS instinct_connector_credentials_auth_type_chk;

ALTER TABLE instinct_connector_credentials
  ADD CONSTRAINT instinct_connector_credentials_auth_type_chk
  CHECK (auth_type IN ('static_bearer','oauth2','username_password','oauth_password'));

COMMENT ON COLUMN instinct_connector_credentials.login_path IS
  'Auth endpoint path. For username_password: the form-login path the connector POSTs username/password to (e.g. /api/auth/login). For oauth_password: the OAuth2 token endpoint the connector POSTs the client_id/client_secret/username/password quad to (e.g. /services/oauth2/token). Null otherwise.';

COMMIT;

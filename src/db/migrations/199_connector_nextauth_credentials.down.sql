-- Down migration for 199_connector_nextauth_credentials.
--
-- Restores the 4-value auth_type CHECK constraint (182's state). Any rows with
-- auth_type = 'nextauth_credentials' must be removed/converted first, or the
-- re-added constraint will reject them. No columns are dropped (199 added none).

BEGIN;

ALTER TABLE instinct_connector_credentials
  DROP CONSTRAINT IF EXISTS instinct_connector_credentials_auth_type_chk;

ALTER TABLE instinct_connector_credentials
  ADD CONSTRAINT instinct_connector_credentials_auth_type_chk
  CHECK (auth_type IN ('static_bearer','oauth2','username_password','oauth_password'));

COMMENT ON COLUMN instinct_connector_credentials.login_path IS
  'Auth endpoint path. For username_password: the form-login path the connector POSTs username/password to (e.g. /api/auth/login). For oauth_password: the OAuth2 token endpoint the connector POSTs the client_id/client_secret/username/password quad to (e.g. /services/oauth2/token). Null otherwise.';

COMMIT;

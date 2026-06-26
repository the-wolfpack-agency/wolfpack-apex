-- Down migration for 182_connector_oauth_password.
--
-- Restores the 3-value auth_type CHECK constraint (static_bearer, oauth2,
-- username_password — migration 181's state). Any rows that were written
-- with auth_type = 'oauth_password' must be removed/converted before running
-- this down migration, or the re-added constraint will reject them.
--
-- No columns are dropped: migration 182 added none. login_path stays (it
-- belongs to migration 181). This only narrows the CHECK constraint back.

BEGIN;

ALTER TABLE instinct_connector_credentials
  DROP CONSTRAINT IF EXISTS instinct_connector_credentials_auth_type_chk;

ALTER TABLE instinct_connector_credentials
  ADD CONSTRAINT instinct_connector_credentials_auth_type_chk
  CHECK (auth_type IN ('static_bearer','oauth2','username_password'));

COMMENT ON COLUMN instinct_connector_credentials.login_path IS
  'Form-login endpoint path the connector POSTs username/password to (e.g. /api/auth/login). Null unless auth_type = username_password.';

COMMIT;

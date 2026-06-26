-- Down migration for 181_connector_username_password.
--
-- Restores the 2-value auth_type CHECK constraint (static_bearer,
-- oauth2) and drops the form-login columns. Any rows that were written
-- with auth_type = 'username_password' must be removed/converted before
-- running this down migration, or the re-added constraint will reject
-- them.

BEGIN;

ALTER TABLE instinct_connector_credentials
  DROP CONSTRAINT IF EXISTS instinct_connector_credentials_auth_type_chk;

ALTER TABLE instinct_connector_credentials
  DROP COLUMN IF EXISTS login_path,
  DROP COLUMN IF EXISTS session_cookie_name;

ALTER TABLE instinct_connector_credentials
  ADD CONSTRAINT instinct_connector_credentials_auth_type_chk
  CHECK (auth_type IN ('static_bearer','oauth2'));

COMMIT;

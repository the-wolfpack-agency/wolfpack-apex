-- Down migration for 138_connector_oauth.

BEGIN;

DROP INDEX IF EXISTS idx_connector_credentials_expiring;

ALTER TABLE instinct_connector_credentials
  DROP CONSTRAINT IF EXISTS instinct_connector_credentials_auth_type_chk;

ALTER TABLE instinct_connector_credentials
  DROP COLUMN IF EXISTS auth_type,
  DROP COLUMN IF EXISTS refresh_token_enc,
  DROP COLUMN IF EXISTS access_token_expires_at,
  DROP COLUMN IF EXISTS oauth_provider_metadata;

COMMIT;

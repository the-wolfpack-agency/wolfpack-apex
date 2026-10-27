-- Rollback for 299_forcefield_plugin_connect.sql (ops-only; never run by deploy).
DROP INDEX IF EXISTS forcefield_signup_requests_plugin_secret;
ALTER TABLE forcefield_signup_requests
  DROP COLUMN IF EXISTS detected_platform,
  DROP COLUMN IF EXISTS plugin_secret_sha256,
  DROP COLUMN IF EXISTS plugin_linked_at;

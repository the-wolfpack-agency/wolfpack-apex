BEGIN;
DROP INDEX IF EXISTS idx_connector_credentials_workspace_active;
DROP TABLE IF EXISTS instinct_connector_credentials;
COMMIT;

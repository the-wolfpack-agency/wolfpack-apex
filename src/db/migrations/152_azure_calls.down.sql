BEGIN;
DROP INDEX IF EXISTS ix_instinct_azure_calls_doc;
DROP INDEX IF EXISTS ix_instinct_azure_calls_service_created;
DROP TABLE IF EXISTS instinct_azure_calls;
COMMIT;

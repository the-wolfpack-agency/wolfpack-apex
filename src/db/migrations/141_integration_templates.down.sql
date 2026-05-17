-- Down for migration 141 — integration_templates.

BEGIN;

DROP INDEX IF EXISTS integration_templates_active_idx;
DROP INDEX IF EXISTS integration_templates_vendor_object_idx;
DROP TABLE IF EXISTS integration_templates;

COMMIT;

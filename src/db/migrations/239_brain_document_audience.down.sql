ALTER TABLE instinct_sharepoint_sources DROP COLUMN IF EXISTS audience_roles;
DROP INDEX IF EXISTS brain_documents_audience_idx;
ALTER TABLE brain_documents DROP COLUMN IF EXISTS audience_roles;

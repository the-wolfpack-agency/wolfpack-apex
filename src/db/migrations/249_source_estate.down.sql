-- Revert 249. The estate labels are lost, which means every client-facing
-- count goes back to reporting one tenant's whole drive as one client's
-- library.
DROP INDEX IF EXISTS idx_brain_documents_estate;
ALTER TABLE brain_documents DROP COLUMN IF EXISTS estate;
ALTER TABLE instinct_sharepoint_sources DROP COLUMN IF EXISTS estate;

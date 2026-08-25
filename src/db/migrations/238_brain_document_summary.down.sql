DROP INDEX IF EXISTS brain_documents_summary_present_idx;
DROP INDEX IF EXISTS brain_documents_topics_idx;
ALTER TABLE brain_documents DROP COLUMN IF EXISTS topics;
ALTER TABLE brain_documents DROP COLUMN IF EXISTS summary;

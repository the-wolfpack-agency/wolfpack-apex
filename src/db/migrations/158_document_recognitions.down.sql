-- Reverse migration 158.
BEGIN;
DROP INDEX IF EXISTS instinct_document_recognitions_sha256_idx;
DROP INDEX IF EXISTS instinct_document_recognitions_classified_type_idx;
DROP INDEX IF EXISTS instinct_document_recognitions_uploaded_at_idx;
DROP INDEX IF EXISTS instinct_document_recognitions_workspace_idx;
DROP TABLE IF EXISTS instinct_document_recognitions;
COMMIT;

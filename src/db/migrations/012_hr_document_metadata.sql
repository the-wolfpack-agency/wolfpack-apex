-- 012_hr_document_metadata.sql — Add metadata JSONB column to apex_hr_documents.
--
-- Stores structured field extraction results for W-4 and I-9 documents.
-- The smart router populates this column when the classifier identifies
-- a document as w4 or i9 and the field extractor runs.
--
-- Schema: { fields: {...}, field_count: N, total_fields: N, completeness: 0..1, extraction_notes: [...] }

ALTER TABLE apex_hr_documents
  ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb;

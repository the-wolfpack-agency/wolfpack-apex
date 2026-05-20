-- Down migration 148 — revert brain_documents.kind CHECK to the
-- pre-xlsx set. Only safe if no rows currently have kind='xlsx';
-- caller is expected to have moved or deleted them first.

BEGIN;

ALTER TABLE brain_documents
  DROP CONSTRAINT IF EXISTS brain_documents_kind_check;

ALTER TABLE brain_documents
  ADD CONSTRAINT brain_documents_kind_check
  CHECK (kind IN (
    'pdf', 'docx',
    'text', 'markdown', 'csv', 'html',
    'audio', 'video', 'image', 'email',
    'other'
  ));

COMMIT;

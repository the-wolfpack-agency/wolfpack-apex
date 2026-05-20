-- Migration 148 — expand brain_documents.kind CHECK to include 'xlsx'.
--
-- The original migration 028 enumerated the BrainKind union as it
-- existed then: pdf, docx, text, markdown, csv, html, audio, video,
-- image, email, other. The TS union in src/lib/brain/types.ts has
-- since grown 'xlsx' (extractor + classifier + magic-byte gate all
-- shipped in 6600dfa) but the DB constraint never followed.
--
-- Result on 2026-05-20: live xlsx upload returned reasons="internal"
-- with no brain_documents row, no chunk, no chip-rendered reason —
-- because the INSERT failed the CHECK and the route caught it as a
-- generic 500. The analytics trail showed brain.upload_started then
-- brain.upload_rejected:internal back-to-back, with kind=xlsx in the
-- started metadata but no row in brain_documents to match.
--
-- This migration adds 'xlsx' to the allowed set. Idempotent: DROP
-- the old constraint if present then re-add with the full union.
-- Existing rows (none are 'xlsx' yet, since the INSERT was rejected)
-- are unaffected.

BEGIN;

ALTER TABLE brain_documents
  DROP CONSTRAINT IF EXISTS brain_documents_kind_check;

ALTER TABLE brain_documents
  ADD CONSTRAINT brain_documents_kind_check
  CHECK (kind IN (
    'pdf', 'docx', 'xlsx',
    'text', 'markdown', 'csv', 'html',
    'audio', 'video', 'image', 'email',
    'other'
  ));

COMMIT;

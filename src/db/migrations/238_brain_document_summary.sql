-- What a document IS, worked out once at ingest.
--
-- Retrieval matches chunks, and a chunk is a slice of a page. A question about
-- meeting briefs returned "BA102_Day 3 (chunk 18)": text starting mid-sentence
-- from a document whose subject appears nowhere in the slice. Storing the
-- summary lets a citation say what the document is, and the matching summary
-- chunk (brain_chunks, chunk_idx 0) lets retrieval match the document rather
-- than needing to collide with the right paragraph.
--
-- Nullable on purpose. Enrichment is best-effort: a model being unavailable
-- must never cost the document itself, and every row written before this
-- migration is legitimately null rather than missing.
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS summary TEXT;
ALTER TABLE brain_documents ADD COLUMN IF NOT EXISTS topics TEXT[];

-- Topic search is a lookup by label, which is what a GIN index is for.
CREATE INDEX IF NOT EXISTS brain_documents_topics_idx
  ON brain_documents USING GIN (topics);

-- How much of the library has been described, answerable without a scan.
CREATE INDEX IF NOT EXISTS brain_documents_summary_present_idx
  ON brain_documents ((summary IS NOT NULL));

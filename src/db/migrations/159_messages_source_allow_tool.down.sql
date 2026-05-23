-- Revert 159: restore migration 008's allowed source set.
-- WARNING: rows with source IN ('tool','page_facts','memory','cache')
-- written between 159 and this rollback will fail the restored CHECK.
-- Inspect first:
--   SELECT source, COUNT(*) FROM instinct_messages
--     WHERE source IN ('tool','page_facts','memory','cache') GROUP BY source;

ALTER TABLE instinct_messages
  DROP CONSTRAINT IF EXISTS apex_messages_source_check;

ALTER TABLE instinct_messages
  ADD CONSTRAINT apex_messages_source_check
  CHECK (source IN (
    'knowledge_cache',
    'codebase',
    'analytics',
    'meeting_transcripts',
    'ai',
    'fallback'
  ));

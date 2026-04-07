-- Allow the assistant to record 'meeting_transcripts' as a message source.
-- The original CHECK constraint in 003_assistant_memory.sql restricted
-- source to ('knowledge_cache', 'codebase', 'analytics', 'ai', 'fallback').
-- With Plaud meeting ingestion live, the assistant can now answer
-- questions from meeting context — that needs its own source label so
-- the analytics + learning loop can break it out.

ALTER TABLE apex_messages
  DROP CONSTRAINT IF EXISTS apex_messages_source_check;

ALTER TABLE apex_messages
  ADD CONSTRAINT apex_messages_source_check
  CHECK (source IN (
    'knowledge_cache',
    'codebase',
    'analytics',
    'meeting_transcripts',
    'ai',
    'fallback'
  ));

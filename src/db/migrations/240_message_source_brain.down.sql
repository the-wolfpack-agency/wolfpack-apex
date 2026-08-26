ALTER TABLE instinct_messages DROP CONSTRAINT IF EXISTS apex_messages_source_check;
ALTER TABLE instinct_messages ADD CONSTRAINT apex_messages_source_check
  CHECK (
    source IS NULL OR source = ANY (ARRAY[
      'knowledge_cache','codebase','analytics','meeting_transcripts',
      'ai','fallback','tool','page_facts','memory','cache'
    ]::text[])
  );

-- A broadcast is a message the organisation sent, and it needs somewhere to go.
--
-- An announcement written into every person's assistant is stored as an
-- assistant message with source 'broadcast'. That value was not in this
-- constraint, so every delivery would have violated it and the insert would
-- have failed.
--
-- Silently, again. The message write is fire-and-forget, so the sender would
-- have been told the company was messaged while nobody received anything, and
-- the only evidence would have been server log lines. That is the same failure
-- 240 fixed for 'brain' and 'user_qa_cache', and it was caught here before it
-- shipped because message-source-parity.test.ts now compares the TypeScript
-- union against this list on every run.
--
-- The value is deliberately its own source rather than reusing an existing
-- one. The org-wide answer cache and the knowledge base both read assistant
-- messages, and a broadcast must never be replayed as an answer or promoted
-- into a curated fact: "submit expenses by Friday" is not this company's
-- standing answer about expenses. Both cache paths now exclude it explicitly.
ALTER TABLE instinct_messages DROP CONSTRAINT IF EXISTS apex_messages_source_check;

ALTER TABLE instinct_messages ADD CONSTRAINT apex_messages_source_check
  CHECK (
    source IS NULL OR source = ANY (ARRAY[
      'knowledge_cache',
      'codebase',
      'analytics',
      'meeting_transcripts',
      'ai',
      'fallback',
      'tool',
      'page_facts',
      'memory',
      'cache',
      'brain',
      'user_qa_cache',
      'broadcast'
    ]::text[])
  );

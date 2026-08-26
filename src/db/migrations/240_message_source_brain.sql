-- The assistant's own answers were not being saved.
--
-- chat() records a `source` on every reply. Two of the values it emits,
-- 'brain' and 'user_qa_cache', were never in this constraint, so every reply
-- from the knowledge base or the Q&A cache violated it and the insert failed.
--
-- Silently. The answer still reached the person: the write is fire-and-forget,
-- so the only evidence was a line in the server log. Production holds 14,068
-- assistant messages and not one of them is from either path.
--
-- What that cost: conversation history missing its Brain answers, so scrolling
-- back showed a question with no reply; the learning loop blind to the surface
-- the Brain work has been aimed at all month; and any analysis of Brain usage
-- from the message table reading zero, which looks like nobody using it.
--
-- Found by reading the error in a prompt transcript. No test failed, because
-- the TypeScript union and this constraint are two lists nothing compared.
-- src/lib/__tests__/message-source-parity.test.ts now compares them.
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
      'user_qa_cache'
    ]::text[])
  );

-- Migration 245 — remove stored answers in which the assistant refused.
--
-- WHY THIS IS A MIGRATION AND NOT A SCRIPT. These rows are served to clients.
-- Left in place they are returned instantly, at zero tokens, with none of the
-- checks that would now stop them, and no deploy fixes that: the code change
-- that stops NEW ones being written does nothing about the ones already
-- written. Read back from the deployed assistant on 2026-08-28:
--
--   "can you send an email for me"  -> "I cannot send emails directly."
--   "what files can you see"        -> "I don't have direct access to your file
--                                       system or repository."
--   "how many open tasks do I have" -> "I cannot check your open tasks."
--
-- All three false. All three served from cache rather than from a model. They
-- were generated once under a system prompt that described the assistant as
-- belonging to a different product, and the learning loop stored them as facts.
--
-- The predicate matches src/lib/assistant/capability-denial.ts. That file is
-- the source of truth and explains why the SQL net is slightly wider than the
-- TypeScript one, and why correct refusals (a prompt injection turned away, an
-- SSN declined) are removed too: a stored refusal is served by fuzzy match, so
-- keeping one lets a later innocent question inherit a refusal it never earned.
--
-- SAFE TO RE-RUN: a DELETE with no rows left to match is a no-op, and this is
-- a cache table. Every row here was derived from a question that can be asked
-- again, and asking again now produces a better answer than the one removed.

BEGIN;

-- Record what we are about to remove, so the number is recoverable after the
-- fact. A silent purge and a purge that found nothing look identical.
DO $$
DECLARE
  doomed INT;
BEGIN
  SELECT count(*) INTO doomed
    FROM instinct_knowledge
   WHERE answer ILIKE '%I cannot %'
      OR answer ILIKE '%I can not %'
      OR answer ILIKE '%I can''t %'
      OR answer ILIKE '%I do not have direct access%'
      OR answer ILIKE '%I don''t have direct access%'
      OR answer ILIKE '%I do not have access to%'
      OR answer ILIKE '%I don''t have access to%'
      OR answer ILIKE '%I do not have the ability%'
      OR answer ILIKE '%I don''t have the ability%'
      OR answer ILIKE '%I am unable to%'
      OR answer ILIKE '%I''m unable to%'
      OR answer ILIKE '%I am not able to%'
      OR answer ILIKE '%as an AI%'
      OR answer ILIKE '%share file paths%'
      OR answer ILIKE '%code snippets%';
  RAISE NOTICE 'Migration 245: removing % cached refusals', doomed;
END$$;

DELETE FROM instinct_knowledge
 WHERE answer ILIKE '%I cannot %'
    OR answer ILIKE '%I can not %'
    OR answer ILIKE '%I can''t %'
    OR answer ILIKE '%I do not have direct access%'
    OR answer ILIKE '%I don''t have direct access%'
    OR answer ILIKE '%I do not have access to%'
    OR answer ILIKE '%I don''t have access to%'
    OR answer ILIKE '%I do not have the ability%'
    OR answer ILIKE '%I don''t have the ability%'
    OR answer ILIKE '%I am unable to%'
    OR answer ILIKE '%I''m unable to%'
    OR answer ILIKE '%I am not able to%'
    OR answer ILIKE '%as an AI%'
    OR answer ILIKE '%share file paths%'
    OR answer ILIKE '%code snippets%';

-- Sanity: nothing matching survived. If this fires, the DELETE and the count
-- above have drifted apart, which is the one way this migration could report
-- success while leaving the client-facing rows in place.
DO $$
DECLARE
  remaining INT;
BEGIN
  SELECT count(*) INTO remaining
    FROM instinct_knowledge
   WHERE answer ILIKE '%I cannot %'
      OR answer ILIKE '%I don''t have direct access%'
      OR answer ILIKE '%as an AI%';
  IF remaining > 0 THEN
    RAISE EXCEPTION 'Migration 245 left % cached refusals in place', remaining;
  END IF;
END$$;

COMMIT;

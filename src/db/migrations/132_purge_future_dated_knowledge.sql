-- Migration 132 — Purge knowledge-cache entries that describe a past event
-- with a future date.
--
-- Why: 2026-05-14, the Assistant served (with a "Zero tokens" cache-hit
-- badge) the answer "Your first recorded meeting with Max Fuerst was on
-- June 4, 2026, during the Wolfpack Weekly Tech Team Call." Today is
-- 2026-05-14 — June 4 is in the future, so this is a hallucination.
-- The downstream prevention (src/lib/knowledge.ts saveAnswer veto +
-- src/lib/plaud.ts query filter) stops new entries from landing, but
-- existing rows in instinct_knowledge persist forever (no TTL). This
-- migration deletes them once.
--
-- Heuristic: an answer that contains BOTH a past-event verb AND a date
-- string parseable to a moment strictly after the migration's run time
-- is treated as poisoned. We don't try to be exhaustive — the
-- application-layer veto is the real guard going forward.

BEGIN;

WITH future_dated_answers AS (
  SELECT id, answer
  FROM instinct_knowledge
  WHERE answer ~* '\b(was|were|happened|occurred|took place|met|recorded|signed|closed|attended|joined|completed|finished|spoke|talked|discussed|reviewed|launched|shipped|published|fired|hired|left|departed)\b'
    -- Heuristic year-in-future check: any 4-digit year > current year.
    AND answer ~ ('\m(' ||
        (EXTRACT(YEAR FROM CURRENT_DATE)::int + 1)::text || '|' ||
        (EXTRACT(YEAR FROM CURRENT_DATE)::int + 2)::text || '|' ||
        '2[0-9]{2}[0-9])\M')
)
DELETE FROM instinct_knowledge
WHERE id IN (SELECT id FROM future_dated_answers)
RETURNING id, asked_by, LEFT(answer, 100) AS answer_preview;

COMMIT;

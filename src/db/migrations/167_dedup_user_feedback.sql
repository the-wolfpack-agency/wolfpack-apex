-- Migration 167: one-time physical de-duplication of instinct_user_feedback.
--
-- Why: /admin/feedback kept showing the same note over and over with a fresh
-- timestamp. Two causes, both now fixed at the source:
--   1. The feedback assistant tool's intent regex auto-recorded the trailing
--      words of any natural-language phrase that started with "feedback" /
--      "share feedback" (a starter chip "share feedback about Instinct" wrote a
--      row on every click). The tool now routes that to a compose widget and
--      never writes silently.
--   2. The read-side inbox dedup was case/whitespace sensitive, so near-
--      identical repeats slipped through as separate cards. The route now groups
--      by lower(btrim(message)).
--
-- This migration removes the rows those bugs already created. It is data
-- cleanup only: NO schema change.
--
-- Keep/delete rule, per (workspace_id, user_id, btrim(lower(message))) group:
--   - keep exactly ONE row;
--   - prefer a row with resolved_at NOT NULL (so a resolution is never lost);
--   - otherwise keep the EARLIEST created_at (the original submission);
--   - delete the rest.
--
-- Idempotent by nature: re-running finds no duplicates and deletes nothing. The
-- read-side collapse keeps the inbox correct even before this runs; this just
-- shrinks the physical table so counts and exports stop double-counting.

BEGIN;

WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY workspace_id, user_id, btrim(lower(message))
           ORDER BY (resolved_at IS NOT NULL) DESC, created_at ASC
         ) AS rn
  FROM instinct_user_feedback
),
deleted AS (
  DELETE FROM instinct_user_feedback
  WHERE id IN (SELECT id FROM ranked WHERE rn > 1)
  RETURNING id
)
SELECT count(*) AS removed_duplicate_feedback_rows FROM deleted;

DO $$
DECLARE
  remaining bigint;
BEGIN
  SELECT count(*) INTO remaining
  FROM (
    SELECT 1
    FROM instinct_user_feedback
    GROUP BY workspace_id, user_id, btrim(lower(message))
    HAVING count(*) > 1
  ) dups;
  RAISE NOTICE 'migration 167: % duplicate feedback group(s) remain after cleanup', remaining;
END $$;

COMMIT;

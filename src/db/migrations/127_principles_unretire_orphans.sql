-- 127_principles_unretire_orphans.sql — restore principles that were
-- retired by an empty-parsed-set sync.
--
-- Bug: src/lib/principles/store.ts syncPrinciplesFromParsed step 3 sets
-- retired_at on every active row whose slug isn't in the parsed input.
-- When the cron ran against a doc that returned no parsed principles
-- (config pointing at a stale / empty SharePoint URL, or a parser
-- failure that returned []), every active principle was retired —
-- silently, en masse.
--
-- The data is intact in instinct_principles with retired_at set. This
-- migration un-retires the MOST RECENT row per slug whenever there is
-- no currently-active row for that slug. Idempotent — already-active
-- principles are untouched.
--
-- Pair with the code-side guard landing in the same deploy:
-- syncPrinciplesFromParsed now refuses to retire when the parsed
-- input is empty.

BEGIN;

WITH most_recent_retired AS (
  SELECT DISTINCT ON (slug) id, slug
    FROM instinct_principles
   ORDER BY slug, created_at DESC
)
UPDATE instinct_principles p
   SET retired_at = NULL,
       updated_at = NOW()
  FROM most_recent_retired r
 WHERE p.id = r.id
   AND p.retired_at IS NOT NULL
   AND NOT EXISTS (
     SELECT 1 FROM instinct_principles p2
      WHERE p2.slug = p.slug AND p2.retired_at IS NULL
   );

-- Sanity log via NOTICE so the deploy log shows what was restored.
DO $$
DECLARE
  active_count INT;
BEGIN
  SELECT COUNT(*) INTO active_count
    FROM instinct_principles
   WHERE retired_at IS NULL;
  RAISE NOTICE 'principles active after un-retire: %', active_count;
END $$;

COMMIT;

-- 128_team_members_dedupe_and_unique.sql — merge duplicate team-member
-- rows by email, repoint cross-table references, wipe stale derived
-- observations, add the missing UNIQUE constraint that prevents
-- re-introduction.
--
-- Why duplicates existed: instinct_team_members never had a UNIQUE
-- constraint on email. The MS sign-in upsert relied on
-- `ON CONFLICT (email) DO UPDATE`, which silently no-ops without a
-- real UNIQUE constraint to conflict against — so each sign-in that
-- didn't find a row created a new one. By the time the user looked at
-- the team scoreboard, "Nick Homyk" appeared 4 times under each
-- per-member row because 4 user-id rows shared his email.
--
-- Fix algorithm (one transaction):
--   1. Pick canonical id per LOWER(email) — earliest created_at,
--      smallest id as tiebreak.
--   2. UPDATE instinct_ms_tokens.connected_by → canonical id.
--   3. TRUNCATE instinct_principle_observations — pure derived data;
--      the cron repopulates against the canonical user list and the
--      natural-key unique index from migration 122 now catches the
--      duplicates that would otherwise collide on re-insert.
--   4. DELETE non-canonical instinct_team_members rows.
--   5. CREATE UNIQUE INDEX on LOWER(email) so future inserts CANNOT
--      duplicate. Lower-cased so case variants (Homyk@ vs homyk@)
--      collide too.

BEGIN;

-- 1. Stage canonical-id-per-email lookup.
CREATE TEMPORARY TABLE _canonical_team_ids AS
SELECT DISTINCT ON (LOWER(email))
       id        AS canonical_id,
       LOWER(email) AS lower_email
  FROM instinct_team_members
 ORDER BY LOWER(email), created_at ASC, id ASC;

-- 2a. Dedupe instinct_ms_tokens BEFORE repointing. The table has a
--     UNIQUE index on connected_by, so two existing rows with the
--     same email but different connected_by user-ids would collide
--     on the UPDATE in step 2b. For each canonical email, keep the
--     row with the MOST RECENT connected_at (freshest token + tz +
--     refresh secret) and delete the rest.
WITH rank_by_email AS (
  SELECT t.id,
         ROW_NUMBER() OVER (
           PARTITION BY LOWER(t.user_email)
           ORDER BY t.connected_at DESC, t.id ASC
         ) AS rn
    FROM instinct_ms_tokens t
   WHERE LOWER(t.user_email) IN (SELECT lower_email FROM _canonical_team_ids)
)
DELETE FROM instinct_ms_tokens t
 USING rank_by_email r
 WHERE t.id = r.id
   AND r.rn > 1;

-- 2b. Repoint the SURVIVING ms_tokens row to the canonical user id.
UPDATE instinct_ms_tokens t
   SET connected_by = c.canonical_id
  FROM _canonical_team_ids c
 WHERE LOWER(t.user_email) = c.lower_email
   AND t.connected_by IS DISTINCT FROM c.canonical_id;

-- 3. Wipe observations — cron repopulates clean.
TRUNCATE TABLE instinct_principle_observations;

-- 4. Delete non-canonical team-member rows.
DELETE FROM instinct_team_members m
 WHERE m.id NOT IN (SELECT canonical_id FROM _canonical_team_ids);

-- 5. Unique constraint that should have shipped in migration 001.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_team_members_email_lower
  ON instinct_team_members (LOWER(email));

-- 6. Sanity: zero duplicates remain.
DO $$
DECLARE
  dup_count INT;
BEGIN
  SELECT COUNT(*) INTO dup_count
    FROM (
      SELECT 1 FROM instinct_team_members
       GROUP BY LOWER(email)
      HAVING COUNT(*) > 1
    ) t;
  ASSERT dup_count = 0,
    format('team-members duplicates remain after dedupe: %s emails', dup_count);
END $$;

DROP TABLE _canonical_team_ids;

COMMIT;

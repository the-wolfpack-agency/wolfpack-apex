-- 248: the unique index every Microsoft token write has been failing without.
--
-- WHAT WAS BROKEN
--
-- storeTokens upserts with ON CONFLICT (connected_by). Postgres requires a
-- UNIQUE index on that column to match the specification; production had a
-- plain one:
--
--   CREATE INDEX idx_instinct_ms_tokens_connected_by ... (connected_by)
--
-- So every write raised 42P10, "there is no unique or exclusion constraint
-- matching the ON CONFLICT specification". storeTokens swallows its error and
-- the caller emits microsoft.token_refreshed immediately afterwards, so the
-- failure was invisible: 2,592 refresh events in 24 hours against six accounts
-- (roughly eighteen times the healthy rate, because nothing was ever saved and
-- every call refreshed again), while the newest stored token stayed expired at
-- 2026-08-26.
--
-- The visible damage was elsewhere. Interactive requests kept working, because
-- each one refreshed in memory. Anything reading a STORED token did not:
-- getValidToken returned null for the background jobs, so the SharePoint sync
-- stopped on 2026-08-27 and the library repair failed every run with no_token.
--
-- WHERE THE INDEX WENT
--
-- Migration 006 created it UNIQUE and 044 renamed it, which preserves
-- uniqueness. The live index is not unique, and the live email index IS unique
-- where 006 made it plain: the two are exactly inverted from what the chain
-- says. No migration since touches either, and none ran at the hour the tokens
-- froze. That is as far as the evidence goes, so this migration does not claim
-- a cause. It restores the state the code has always required and ships a check
-- that fails loudly if any upsert target drifts again.
--
-- SAFE TO RUN
--
-- Deduplicated first, keeping the freshest row per account, on the same rule
-- migration 128 used. Measured before writing this: zero duplicates today, so
-- the DELETE is a no-op here and insurance for any database where it is not.
-- Idempotent, and reversible via 248_..._unique.down.sql.

-- 1. One row per connected user, keeping the most recently connected.
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY connected_by
           ORDER BY connected_at DESC NULLS LAST, updated_at DESC NULLS LAST, id ASC
         ) AS rn
    FROM instinct_ms_tokens
   WHERE connected_by IS NOT NULL
)
DELETE FROM instinct_ms_tokens t
 USING ranked r
 WHERE t.id = r.id AND r.rn > 1;

-- 2. The index the upsert names. Created under a NEW name rather than trying to
--    alter the old one in place: an index cannot be made unique by ALTER, and
--    dropping the one queries may be using before the replacement exists is a
--    window where every lookup goes to a sequential scan.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_ms_tokens_connected_by
  ON instinct_ms_tokens (connected_by);

-- 3. The plain one is now redundant: a unique btree serves every read the
--    non-unique one did.
DROP INDEX IF EXISTS idx_instinct_ms_tokens_connected_by;

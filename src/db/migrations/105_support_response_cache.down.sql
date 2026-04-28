-- 105_support_response_cache.down.sql — reversible teardown of 105.
--
-- Drops the cache_ids column then the cache table + its indexes.
-- IF EXISTS everywhere so the down migration is safe to re-run.
--
-- WARNING: this drops every cached AI response. After a down + up cycle
-- the next request for every cached input will burn fresh tokens until
-- the cache repopulates. The original tickets and patterns are unaffected.

BEGIN;

ALTER TABLE instinct_support_tickets
  DROP COLUMN IF EXISTS cache_ids;

DROP INDEX IF EXISTS idx_support_response_cache_last_used;
DROP INDEX IF EXISTS idx_support_response_cache_feature_sig;

DROP TABLE IF EXISTS instinct_support_response_cache;

COMMIT;

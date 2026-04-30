-- 108_knowledge_qa_cache.down.sql — reversible teardown of 108.
--
-- Drops the indexes then the table. IF EXISTS everywhere so the down
-- migration is safe to re-run.
--
-- WARNING: this drops every cached AI Q&A. After a down + up cycle the
-- next request for every cached question will burn fresh tokens until
-- the cache repopulates. The original instinct_knowledge entries are
-- unaffected.

BEGIN;

DROP INDEX IF EXISTS idx_qa_quality_signal;
DROP INDEX IF EXISTS idx_qa_surface;
DROP INDEX IF EXISTS idx_qa_normalized;

DROP TABLE IF EXISTS knowledge_qa_entries;

COMMIT;

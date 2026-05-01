-- 116_principles.down.sql — reverse 116.

BEGIN;

DROP TABLE IF EXISTS instinct_principle_observations CASCADE;
DROP TABLE IF EXISTS instinct_principle_signals CASCADE;
DROP TABLE IF EXISTS instinct_principles CASCADE;
DROP TABLE IF EXISTS instinct_principle_doc_versions CASCADE;

COMMIT;

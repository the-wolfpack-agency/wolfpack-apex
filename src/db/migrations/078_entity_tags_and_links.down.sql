-- Reverse of 078_entity_tags_and_links.sql
--
-- Drops the L3 polymorphic tag + link tables. Safe to re-run (IF EXISTS
-- on everything). Does NOT touch the L1 canonical tables owned by U1's
-- migration 077 — L3 is a strict superset layer.

BEGIN;

DROP INDEX IF EXISTS uq_instinct_entity_links_dedup;
DROP INDEX IF EXISTS idx_instinct_entity_links_type;
DROP INDEX IF EXISTS idx_instinct_entity_links_to;
DROP INDEX IF EXISTS idx_instinct_entity_links_from;
DROP TABLE IF EXISTS instinct_entity_links;

DROP INDEX IF EXISTS uq_instinct_entity_tags_dedup;
DROP INDEX IF EXISTS idx_instinct_entity_tags_key_value;
DROP INDEX IF EXISTS idx_instinct_entity_tags_entity;
DROP TABLE IF EXISTS instinct_entity_tags;

COMMIT;

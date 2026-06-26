-- Down migration for 185_audit_chain_anchors.
--
-- Drops only what migration 185 added: the instinct_audit_chain_anchors table
-- and its index. The instinct_audit_log rows themselves are NOT touched (they
-- remain append-only); dropping the anchors merely makes previously-acknowledged
-- breaks re-fail verifyChain until re-anchored.

BEGIN;

DROP INDEX IF EXISTS idx_audit_chain_anchors_seq;
DROP TABLE IF EXISTS instinct_audit_chain_anchors;

COMMIT;

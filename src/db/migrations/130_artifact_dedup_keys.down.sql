-- 130_artifact_dedup_keys.down.sql — reverse migration 130.
-- Drops the new dedup_key + internet_message_id columns and the
-- associated indexes. The legacy (source_message_id, content_sha256)
-- UNIQUE index remains intact, so artifact-level idempotency degrades
-- back to the pre-migration contract.

BEGIN;

DROP INDEX IF EXISTS uq_instinct_auto_porsche_artifacts_dedup_key;
DROP INDEX IF EXISTS idx_instinct_auto_porsche_artifacts_imid;

ALTER TABLE instinct_automation_porsche_artifacts
  DROP COLUMN IF EXISTS dedup_key;

ALTER TABLE instinct_automation_porsche_artifacts
  DROP COLUMN IF EXISTS internet_message_id;

COMMIT;

-- Down for migration 144 — reverts user_feedback column types to UUID.
-- DANGEROUS: will FAIL on any rows whose workspace_id is not a parseable
-- UUID (e.g. the literal 'default'). Run only against an empty table.

BEGIN;

ALTER TABLE instinct_user_feedback
  ALTER COLUMN workspace_id DROP DEFAULT;

ALTER TABLE instinct_user_feedback
  ALTER COLUMN workspace_id TYPE UUID USING workspace_id::UUID,
  ALTER COLUMN user_id      TYPE UUID USING user_id::UUID,
  ALTER COLUMN workflow_id  TYPE UUID USING workflow_id::UUID;

COMMIT;

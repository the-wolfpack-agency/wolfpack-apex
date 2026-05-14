-- Down migration for 133_assistant_strictness.sql
BEGIN;
ALTER TABLE instinct_workspace DROP COLUMN IF EXISTS assistant_strictness;
COMMIT;

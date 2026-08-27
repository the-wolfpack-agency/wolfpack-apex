DROP INDEX IF EXISTS idx_agents_requires_write_approval;
ALTER TABLE instinct_agents DROP COLUMN IF EXISTS requires_write_approval;

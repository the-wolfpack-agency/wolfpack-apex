-- Down migration for 184_agent_backup.
--
-- Drops only what migration 184 added: the backup_agent_id column on the agent
-- principals table (whichever name exists) and the retry_count column + its
-- index on the tasks table. The agents, tasks, and connections rows themselves
-- are NOT touched.

BEGIN;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'instinct_agent_principals') THEN
    EXECUTE 'ALTER TABLE instinct_agent_principals DROP COLUMN IF EXISTS backup_agent_id';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'instinct_agents') THEN
    EXECUTE 'ALTER TABLE instinct_agents DROP COLUMN IF EXISTS backup_agent_id';
  END IF;
END $$;

DROP INDEX IF EXISTS idx_instinct_agent_tasks_agent_status_queued;

ALTER TABLE instinct_agent_tasks DROP COLUMN IF EXISTS retry_count;

COMMIT;

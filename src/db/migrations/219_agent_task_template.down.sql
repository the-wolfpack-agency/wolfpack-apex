-- Rollback of 219_agent_task_template. Idempotent.
ALTER TABLE instinct_agent_tasks DROP COLUMN IF EXISTS success_criteria;
ALTER TABLE instinct_agent_tasks DROP COLUMN IF EXISTS context;
ALTER TABLE instinct_agent_tasks DROP COLUMN IF EXISTS target_connection_id;
ALTER TABLE instinct_agent_tasks DROP COLUMN IF EXISTS source;

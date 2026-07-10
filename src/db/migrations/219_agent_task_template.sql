-- Structured task-template fields for agent tasks (the control plane).
--
-- The `goal` column stays as the objective the planner runs. These columns
-- capture the rest of the template (definition of done, context, target) so the
-- data is not lost and feeds analytics + the learning loop. All nullable for
-- back-compat with legacy goal-only rows. Additive + idempotent.

ALTER TABLE instinct_agent_tasks ADD COLUMN IF NOT EXISTS success_criteria TEXT;
ALTER TABLE instinct_agent_tasks ADD COLUMN IF NOT EXISTS context TEXT;
ALTER TABLE instinct_agent_tasks ADD COLUMN IF NOT EXISTS target_connection_id TEXT;
-- Where the task was created from: detail_page | chat_widget | api. Learning signal.
ALTER TABLE instinct_agent_tasks ADD COLUMN IF NOT EXISTS source TEXT;

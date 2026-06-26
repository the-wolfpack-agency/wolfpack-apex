-- Migration 184 — GOVERNED backup-agent failover for uptime.
--
-- An agent may designate a BACKUP agent. When the primary goes unhealthy
-- (paused / revoked) or a task stalls, its queued work fails over to the backup,
-- which runs it under the SAME OGIAM gate and the SAME least-privilege scope.
-- Failover never bypasses governance and never escalates scope: the failover
-- store reassigns a queued task to the backup ONLY when the backup is bound to a
-- SUPERSET of the primary's connections (checked in src/lib/agents/failover).
--
-- Schema additions (additive + idempotent):
--   * instinct_agent_principals.backup_agent_id — the designated backup agent id
--     for THIS agent. NULL = no backup. Validation (different, same-workspace,
--     existing, non-cyclic) lives in the store, not a DB constraint, so the
--     onboarding UI can surface a friendly message rather than a 23xxx error.
--   * instinct_agent_tasks.retry_count — how many times a stalled 'running' task
--     has been requeued. The stall reclaimer caps requeues (default 3) and then
--     marks the task 'failed' so a permanently stuck task can never loop forever.
--
-- NOTE: migration 171 created the agents table as `instinct_agents`. This file
-- guards the ALTER with a DO block that targets whichever of the two principal
-- table names exists (`instinct_agent_principals` per the task brief, or the
-- live `instinct_agents`), so the column lands on the real table either way and
-- the migration stays idempotent + re-runnable.
--
-- No silent data loss: both columns are additive, nullable / defaulted, and the
-- down migration drops only what this file added.

BEGIN;

-- backup_agent_id on the agent principals table (whichever name exists).
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'instinct_agent_principals') THEN
    EXECUTE 'ALTER TABLE instinct_agent_principals
               ADD COLUMN IF NOT EXISTS backup_agent_id TEXT';
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.tables
              WHERE table_name = 'instinct_agents') THEN
    EXECUTE 'ALTER TABLE instinct_agents
               ADD COLUMN IF NOT EXISTS backup_agent_id TEXT';
  END IF;
END $$;

-- retry_count on tasks: caps stall-reclaim requeues so a stuck task fails closed
-- after the cap instead of looping.
ALTER TABLE instinct_agent_tasks
  ADD COLUMN IF NOT EXISTS retry_count INTEGER NOT NULL DEFAULT 0;

-- Index the queued-task reassignment read: "what queued work does this agent
-- have" is the hot path the failover sweep runs per unhealthy primary.
CREATE INDEX IF NOT EXISTS idx_instinct_agent_tasks_agent_status_queued
  ON instinct_agent_tasks (agent_id, status);

COMMIT;

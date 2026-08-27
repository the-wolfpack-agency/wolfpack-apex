-- Approval before an agent writes.
--
-- WHY NOW. agent.write_pending_approval, agent.write_approved and
-- agent.write_executed have NEVER fired. Not once, in ninety days, while
-- /playbook told clients the product holds an agent's write until a human
-- approves it. The approvals store exists and is tested; nothing outside its
-- own tests ever called it. The sixth control this month found declared,
-- described accurately, and never wired to anything.
--
-- PER AGENT, NOT GLOBAL. Seventy-three agent tasks have already completed
-- against this workspace. Gating every write behind a human would stop them
-- dead and teach everybody to turn the gate off, which is worse than not
-- having one. An agent trusted to file a task keeps filing tasks; an agent
-- pointed at a client's CRM does not, and that is the difference somebody
-- should be able to set per agent.
--
-- DEFAULT FALSE, deliberately. A migration that silently changes what running
-- agents are allowed to do is a migration that breaks production quietly. The
-- flag is opt in, and the flag being off is visible on the agent page.
ALTER TABLE instinct_agents
  ADD COLUMN IF NOT EXISTS requires_write_approval BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN instinct_agents.requires_write_approval IS
  'When true, a write operation by this agent is captured as a pending approval and NOT executed until a human decides. Off by default so existing agents keep working.';

-- Find the agents a workspace has put behind the gate, without scanning every
-- agent row, because the approvals page asks this on every load.
CREATE INDEX IF NOT EXISTS idx_agents_requires_write_approval
  ON instinct_agents (workspace_id)
  WHERE requires_write_approval = TRUE;

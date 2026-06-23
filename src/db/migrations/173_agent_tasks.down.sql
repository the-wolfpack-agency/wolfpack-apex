-- Down for 173: drop the agent tasks table. Tasks are operational work records;
-- the per-step OGIAM decisions remain in the decision ledger.
DROP TABLE IF EXISTS instinct_agent_tasks;

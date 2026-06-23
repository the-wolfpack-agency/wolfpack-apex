-- Down for 174: drop the shared agent memory. Learned procedures are derived
-- from tasks (still in instinct_agent_tasks) and can be relearned.
DROP TABLE IF EXISTS instinct_agent_memory;

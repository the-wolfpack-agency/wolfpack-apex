-- Down for 171: drop the agent principals table. Removing it deletes the agent
-- identities; their past actions remain in the OGIAM decision ledger and the
-- audit log, which are separate append-only records.
DROP TABLE IF EXISTS instinct_agents;

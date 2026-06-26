-- Down migration for 183_agent_connections.
--
-- Drops the agent↔connection association table. The credential rows
-- (instinct_connector_credentials) and the agent principals (instinct_agents)
-- are NOT touched — this only removes the association layer migration 183 added.

BEGIN;

DROP TABLE IF EXISTS instinct_agent_connections;

COMMIT;

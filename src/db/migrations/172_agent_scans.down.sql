-- Down for 172: drop the agent scans table. The system models are derived
-- discovery artifacts, not the source of truth, so dropping them on rollback
-- loses only the cached models; an agent can rescan.
DROP TABLE IF EXISTS instinct_agent_scans;

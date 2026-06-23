-- Down for 175: drop the baselines and drift events. Both are derived from the
-- OGIAM decision ledger and can be recomputed.
DROP TABLE IF EXISTS instinct_agent_drift_events;
DROP TABLE IF EXISTS instinct_agent_baselines;

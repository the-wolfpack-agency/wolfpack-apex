-- Down for 201_gate_api_keys.sql
-- Drops the external gate API-key table + its indexes. Reversible: re-running
-- the up migration recreates an empty table. Clients must re-mint keys (the
-- plaintext is irrecoverable by design, so a re-mint is required regardless).

BEGIN;

DROP POLICY IF EXISTS instinct_gate_api_keys_all ON instinct_gate_api_keys;
DROP INDEX IF EXISTS idx_gate_api_keys_workspace;
DROP INDEX IF EXISTS idx_gate_api_keys_prefix;
DROP TABLE IF EXISTS instinct_gate_api_keys;

COMMIT;

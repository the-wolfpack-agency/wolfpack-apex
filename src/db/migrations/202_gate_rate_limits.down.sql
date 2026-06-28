-- Down migration for 202_gate_rate_limits.sql.
-- Drops the per-API-key fixed-window rate-limit counter table + its index +
-- policy. Idempotent.

BEGIN;

DROP POLICY IF EXISTS instinct_gate_rate_limits_all ON instinct_gate_rate_limits;
DROP INDEX IF EXISTS idx_gate_rate_limits_window;
DROP TABLE IF EXISTS instinct_gate_rate_limits;

COMMIT;

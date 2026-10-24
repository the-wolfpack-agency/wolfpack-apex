-- Rollback for 290_forcefield_block_expiry.sql (ops-only; never run by deploy).
-- Dropping the column makes every automatic block permanent again.
DROP INDEX IF EXISTS idx_agent_blocked_fp_expires;
ALTER TABLE instinct_agent_blocked_fingerprints DROP COLUMN IF EXISTS expires_at;
ALTER TABLE instinct_agent_operator_blocklist DROP COLUMN IF EXISTS expires_at;

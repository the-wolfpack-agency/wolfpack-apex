-- Forcefield automatic blocks expire; human (admin) blocks do not.
--
-- Before this, an automatic block (a honeytoken trip, a learned-signature match,
-- an /edge/decide auto-block) was permanent: the row was served to every
-- connected site forever, and a coarse operator key could keep 100+ fingerprints
-- blocked network-wide long after the actor stopped. expires_at bounds that.
--
--   expires_at NULL      -> never expires (an admin's deliberate block)
--   expires_at <= now()  -> no longer enforces (readers filter it out)
--
-- Safe on live data: additive columns, no row is deleted. Existing automatic
-- rows (operator_key 'auto:%' / blocked_by 'forcefield.auto') get the default
-- 14-day TTL counted from when they were written, so a legacy unbounded block
-- lapses on the same schedule a new one would. Admin rows are left NULL.
-- Idempotent: ADD COLUMN IF NOT EXISTS, and the backfill only touches rows that
-- are still NULL.

ALTER TABLE instinct_agent_blocked_fingerprints
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE instinct_agent_blocked_fingerprints
   SET expires_at = created_at + interval '14 days'
 WHERE operator_key LIKE 'auto:%'
   AND expires_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_agent_blocked_fp_expires
  ON instinct_agent_blocked_fingerprints (workspace_id, expires_at);

ALTER TABLE instinct_agent_operator_blocklist
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

UPDATE instinct_agent_operator_blocklist
   SET expires_at = blocked_at + interval '14 days'
 WHERE blocked_by = 'forcefield.auto'
   AND expires_at IS NULL;

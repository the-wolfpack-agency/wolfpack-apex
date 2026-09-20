-- Auto-block: when enforcement is on, automatically add a PROVEN-hostile operator
-- to the blocklist so the edge blocks it on sight, without waiting for a human.
-- Off by default and independent of the enforce flag, because auto-blocking is a
-- stronger promise than enforcing a manual decision: it must be a deliberate opt-in.
ALTER TABLE instinct_edge_policy
  ADD COLUMN IF NOT EXISTS auto_block BOOLEAN NOT NULL DEFAULT false;

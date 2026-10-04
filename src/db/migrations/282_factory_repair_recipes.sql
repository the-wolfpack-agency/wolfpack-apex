-- Factory brain #8, REPAIR RECIPES: did the Stage-2 auto-fix loop RESOLVE a gate
-- block, or did it have to hand off to a human? Recorded per block CATEGORY
-- (security / invariant / deep-scan) with the attempt count + outcome, so over
-- time we learn which blocks are reliably auto-fixable (route them through repair)
-- vs which usually need a human (escalate sooner, stop burning re-author attempts).
--
-- Metadata only - a category label + counts, never the authored code or the fix -
-- so, like the other brain tables, it can never become a secret store.
-- Additive + idempotent.
CREATE TABLE IF NOT EXISTS instinct_factory_repair_recipes (
  id           BIGINT GENERATED ALWAYS AS IDENTITY,
  workspace_id TEXT        NOT NULL DEFAULT 'default',
  repo         TEXT        NOT NULL DEFAULT '',
  blocked_by   TEXT        NOT NULL,   -- 'security' | 'invariant' | 'deep-scan'
  attempts     INT         NOT NULL DEFAULT 0,
  resolved     boolean     NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS idx_factory_repair_recipes_lookup
  ON instinct_factory_repair_recipes (workspace_id, blocked_by, created_at DESC);

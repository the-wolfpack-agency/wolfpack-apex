-- Forcefield canary registry.
--
-- Decoys nothing legitimate ever touches, so any interaction is a
-- high-confidence signal (see src/lib/forcefield/tripwire.ts). Per workspace,
-- one row per decoy: a fake token/credential, a decoy route, a honey-row id, or
-- a honeypot tool name. The `value` is a DECOY, not a real secret - but it is
-- kept out of every display surface (the store returns a masked hint), because
-- revealing the list would let an attacker route around the deception.

CREATE TABLE IF NOT EXISTS instinct_forcefield_canaries (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  kind         TEXT        NOT NULL,
  value        TEXT        NOT NULL,
  seeded_in    TEXT        NOT NULL,
  active       BOOLEAN     NOT NULL DEFAULT true,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_forcefield_canaries_kind_chk
    CHECK (kind IN ('token', 'route', 'row', 'tool'))
);

CREATE INDEX IF NOT EXISTS idx_forcefield_canaries_ws_active
  ON instinct_forcefield_canaries (workspace_id, active);

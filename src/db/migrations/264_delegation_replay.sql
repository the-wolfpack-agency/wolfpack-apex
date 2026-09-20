-- Delegation replay defense (Know the Principal hardening). A verified delegation
-- can otherwise be captured and replayed anywhere within its TTL. Each credential
-- now carries a unique jti; the FIRST time we accept it we record the jti here,
-- and any later presentation of the same jti is rejected as a replay. Rows self-
-- expire at the credential's own expiry, so this table stays small.
CREATE TABLE IF NOT EXISTS instinct_delegation_replay (
  jti TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_delegation_replay_expiry ON instinct_delegation_replay (expires_at);

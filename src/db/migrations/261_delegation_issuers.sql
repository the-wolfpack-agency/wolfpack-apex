-- Know the Principal: the registry of delegation issuers a workspace trusts.
--
-- An inbound agent can present a signed delegation credential that names the
-- PRINCIPAL (the human/org accountable for it) and the MANDATE (the scopes it
-- was authorized for). Forcefield verifies that signature against an issuer the
-- workspace has registered here - deterministically, fail-closed. An unknown
-- issuer or a bad signature is "claimed", never "verified": the honesty rail.
--
-- The shared secret is symmetric (HS256, matching OGIAM's own delegation
-- construction). Workspace-scoped; an issuer is unique per workspace.
CREATE TABLE IF NOT EXISTS instinct_delegation_issuers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT NOT NULL,
  issuer TEXT NOT NULL,
  algorithm TEXT NOT NULL DEFAULT 'hs256',
  -- Symmetric verification secret for this issuer. Never returned to clients.
  secret TEXT NOT NULL,
  -- Optional cap on what scopes this issuer may ever grant (defense in depth).
  allowed_scopes TEXT[] NOT NULL DEFAULT '{}',
  created_by TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT delegation_issuer_algo_chk CHECK (algorithm IN ('hs256')),
  CONSTRAINT delegation_issuer_uniq UNIQUE (workspace_id, issuer)
);
CREATE INDEX IF NOT EXISTS idx_delegation_issuers_ws ON instinct_delegation_issuers (workspace_id);

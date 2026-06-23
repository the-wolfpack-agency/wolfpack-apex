-- Migration 171: agent principals (OGIAM, agents onboarded like people).
--
-- An agent is a first-class organizational principal: it has a role (its
-- capabilities resolve from the role exactly as a person's do), a named human
-- owner who is accountable for it, a lifecycle state, and an identity provider.
-- Onboarded through the same invite flow as a human.
--
-- Portability by design: the only agent-specific fields are governance
-- (owner, state, provider). identity_provider lets a local short-lived token
-- prove the loop today and a Microsoft Entra workload identity take over for
-- production and client deployments without changing call sites. The agent id
-- is the actor id used everywhere a user id is used (OGIAM decisions, audit),
-- so an agent's actions are attributable and gated exactly like a person's.
--
-- Ids are TEXT to match the rest of the principal surface (no hard FK to a
-- single users table, since an agent may later be backed by an external IdP
-- subject). Additive and idempotent.

CREATE TABLE IF NOT EXISTS instinct_agents (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           TEXT         NOT NULL,
  name                   TEXT         NOT NULL,
  -- A TeamRole. The agent's capability set resolves from this, least privilege.
  role                   TEXT         NOT NULL,
  -- The accountable human (the owner for AGI). Always set.
  owner_user_id          TEXT         NOT NULL,
  -- Lifecycle: invited (created, not yet logged in), active, paused, revoked.
  state                  TEXT         NOT NULL DEFAULT 'invited',
  -- local (short-lived signed token) or entra (Entra workload identity OIDC).
  identity_provider      TEXT         NOT NULL DEFAULT 'local',
  -- Entra object id (oid) when identity_provider = entra.
  external_subject       TEXT,
  -- SHA-256 hash of the one-time onboarding secret (local provider). The raw
  -- secret is shown once at creation and never stored.
  onboarding_secret_hash TEXT,
  -- pending until the agent runs its self-onboarding scan, then complete.
  scan_status            TEXT         NOT NULL DEFAULT 'pending',
  description            TEXT,
  created_by             TEXT         NOT NULL,
  created_at             TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  activated_at           TIMESTAMPTZ,
  last_seen_at           TIMESTAMPTZ,
  revoked_at             TIMESTAMPTZ,

  -- One agent name per workspace, so the roster reads cleanly.
  CONSTRAINT uq_instinct_agents_workspace_name UNIQUE (workspace_id, name)
);

CREATE INDEX IF NOT EXISTS idx_instinct_agents_workspace
  ON instinct_agents (workspace_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_agents_owner
  ON instinct_agents (owner_user_id);

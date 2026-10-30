-- 303_forcefield_agent_policies.sql
--
-- Per-site AI agent policy: which AI TRAINING crawlers a site turns away. One row
-- per scope:
--   scope            "tenant:<uuid>" for a Forcefield client (site labels are not
--                    unique across tenants), or "site:<label>" for one of our own
--                    internal properties (weekendwithporsche, ogiam.com, ...).
--   blocked_agents   agent ids from the engine's known-agent list whose purpose
--                    is AI training (GPTBot, ClaudeBot, ...). Validated by the
--                    API; empty = every agent allowed, the default.
--   updated_by       who last changed it ("tenant:<uuid>" or an Instinct user id).
-- No row = nothing blocked. Safe on live data: a new table only. Idempotent.

CREATE TABLE IF NOT EXISTS forcefield_agent_policies (
  scope           TEXT PRIMARY KEY,
  blocked_agents  TEXT[] NOT NULL DEFAULT '{}',
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT forcefield_agent_policies_scope_shape CHECK (scope ~ '^(tenant:[0-9a-f-]{36}|site:[a-z0-9._-]{1,64})$')
);

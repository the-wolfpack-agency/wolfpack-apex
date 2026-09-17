-- Migration 254: per-workspace OGIAM entitlements (config, not billing).
--
-- The OGIAM product features (Secure Agent, Forcefield) are ON by default via
-- their env flag. This adds a per-workspace OVERRIDE so an admin can turn a
-- product on/off for one client without a redeploy: resolveEntitlement() reads
-- the override when present, else falls back to the env default. The absence of
-- a row means "no override, use the env default". Workspace-scoped, additive,
-- idempotent, reversible. Ported from the wolfpack-ford self-serve stack (DRY).
CREATE TABLE IF NOT EXISTS instinct_org_entitlements (
  workspace_id text NOT NULL,
  feature      text NOT NULL,
  enabled      boolean NOT NULL,
  updated_by   text,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, feature)
);

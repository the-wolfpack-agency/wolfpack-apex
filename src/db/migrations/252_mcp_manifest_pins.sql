-- MCP manifest pins - known-good fingerprints for drift detection.
--
-- An MCP server can scan clean, earn trust, then silently mutate a tool's
-- description (a rug-pull / tool-poisoning vector the model reads but a human
-- never sees). A pin records the sha256 of the vouched-for tool set (see
-- src/lib/ai-surface/mcp/pin.ts). On the next scan the live manifest is
-- re-fingerprinted; any mismatch raises a CRITICAL manifest_drift finding so the
-- server is contained instead of trusted. Per workspace, one row per
-- (target, server).

CREATE TABLE IF NOT EXISTS instinct_mcp_manifest_pins (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  target       TEXT        NOT NULL,
  server       TEXT        NOT NULL,
  fingerprint  TEXT        NOT NULL,
  tool_count   INTEGER     NOT NULL DEFAULT 0,
  pinned_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_mcp_manifest_pins_uniq
    UNIQUE (workspace_id, target, server)
);

CREATE INDEX IF NOT EXISTS idx_mcp_manifest_pins_ws_target
  ON instinct_mcp_manifest_pins (workspace_id, target);

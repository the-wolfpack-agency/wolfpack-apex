-- Operator reputation: an OPT-IN, cross-workspace threat-intelligence network.
-- Each row is one workspace's confirmed-hostile report of an operator, keyed on
-- the OPAQUE, non-PII operator fingerprint (a behavioral hash, never identity,
-- paths, or PII). Deliberately cross-workspace: this is the network effect. A
-- reader aggregates reports from OTHER workspaces to pre-flag a known-bad
-- operator on sight. A reader NEVER learns which workspaces reported it, only an
-- opaque fingerprint + a count + a worst-severity. Off by default (see optin).
CREATE TABLE IF NOT EXISTS instinct_operator_reputation (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  operator_key     TEXT        NOT NULL,   -- opaque behavioral fingerprint (non-PII)
  workspace_id     TEXT        NOT NULL,   -- the reporting workspace (dedup + breadth count only; never revealed to a reader)
  severity         TEXT        NOT NULL,   -- worst severity this workspace saw
  behavior_classes TEXT[]      NOT NULL DEFAULT '{}',
  reported_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT operator_reputation_severity_chk CHECK (severity IN ('hostile', 'elevated', 'benign')),
  CONSTRAINT operator_reputation_uniq UNIQUE (operator_key, workspace_id)
);
CREATE INDEX IF NOT EXISTS idx_operator_reputation_key ON instinct_operator_reputation (operator_key);

-- Per-workspace opt-in to the shared network. No row = fully off (default). A
-- workspace can contribute (share its confirmed-hostile blocks) and/or consume
-- (see the network's known-bad reputation) independently.
CREATE TABLE IF NOT EXISTS instinct_reputation_optin (
  workspace_id TEXT        PRIMARY KEY,
  contribute   BOOLEAN     NOT NULL DEFAULT false,
  consume      BOOLEAN     NOT NULL DEFAULT false,
  updated_by   TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Policy-as-code for the code gate: a client's OWN engineering/security standards
-- layered ADDITIVELY on top of the built-in gate (extra protected paths + deny
-- rules). Weakening is deliberately NOT representable here - the configurable
-- layer can only tighten. Workspace-scoped; one row per workspace.
CREATE TABLE IF NOT EXISTS instinct_code_gate_policy (
  workspace_id    TEXT        PRIMARY KEY DEFAULT 'default',
  protected_paths JSONB       NOT NULL DEFAULT '[]'::jsonb,
  deny_rules      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  updated_by      TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

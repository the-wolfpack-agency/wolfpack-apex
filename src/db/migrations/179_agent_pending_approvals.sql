-- Migration 179 — agent write approvals (human-in-the-loop)
--
-- When a governed agent proposes a MUTATION (create/update an external CRM
-- record), the OGIAM gate allows it but the dispatcher requires explicit human
-- confirmation before anything mutates. This table captures that exact proposed
-- action so the accountable owner (or an admin) can review and APPROVE it, at
-- which point the captured action executes once, re-gated and on the owner's
-- behalf. The human reviews the precise thing that will run — no re-planning.
--
-- params is the validated tool input captured at gate time (no secrets — CRM
-- field values only). decision_seq links back to the OGIAM ledger decision.
-- Workspace-scoped; queries always filter by workspace_id (mirrors 136).

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_agent_pending_approvals (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT         NOT NULL DEFAULT 'default',
  agent_id      TEXT         NOT NULL,
  owner_user_id TEXT         NOT NULL,
  -- The tool the agent proposed (e.g. "create_external_record") + its validated
  -- params, captured so the exact reviewed action is what executes on approval.
  tool          TEXT         NOT NULL,
  params        JSONB        NOT NULL,
  capability    TEXT         NOT NULL,
  -- The OGIAM decision seq this proposal was recorded under (audit linkage).
  decision_seq  BIGINT,
  status        TEXT         NOT NULL DEFAULT 'pending',
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT now(),
  expires_at    TIMESTAMPTZ  NOT NULL,
  decided_by    TEXT,
  decided_at    TIMESTAMPTZ,
  outcome       JSONB,
  CONSTRAINT instinct_agent_pending_approvals_status_chk
    CHECK (status IN ('pending', 'approved', 'rejected', 'executed', 'expired'))
);

-- Hot lookup: "pending approvals for this workspace, newest first".
CREATE INDEX IF NOT EXISTS idx_agent_approvals_workspace_status
  ON instinct_agent_pending_approvals (workspace_id, status, created_at DESC);

COMMENT ON TABLE instinct_agent_pending_approvals IS
  'Captured agent mutation proposals awaiting human approval; approval executes the exact captured action, re-gated.';

COMMIT;

-- 209_ogiam_enforcement_policy.sql
--
-- PER-CAPABILITY ENFORCEMENT POSTURE for the OGIAM gate.
--
-- The gate decision point (src/lib/ogiam/policy.ts) is pure; whether a decision
-- is ENFORCED (a block actually stops the action) or only MONITORED (recorded,
-- never blocks) is an enforcement-mode choice. Until now that mode was hardcoded
-- at the dispatcher (agents enforce, the human assistant monitors). This table
-- makes the posture an admin-controlled, per-(workspace, capability) policy, so a
-- CISO can graduate "finance.write" or "mail.send" from monitor to enforce
-- without a code deploy - the control knob that turns "we logged what the AI
-- would do" into "we blocked it".
--
-- Resolution (src/lib/ogiam/enforcement-policy.ts): a row here OVERRIDES the
-- default for that capability; absence falls back to the existing default
-- (agent principals enforce, the human assistant monitors), so shipping this
-- table changes NOTHING until an admin sets a row. Fail-safe by construction.
--
-- Schema guard: workspace_id is TEXT (opaque slugs, never UUID), matching the
-- ogiam_* family. mode is constrained to ('monitor','enforce'). Workspace-scoped
-- (carries workspace_id) so the repo-wide tenant-isolation guardrail covers it.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 207/208.
-- Paired 209_ogiam_enforcement_policy.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS ogiam_enforcement_policy (
  workspace_id  TEXT         NOT NULL,
  -- The capability this posture applies to (e.g. 'finance.write', 'mail.send').
  capability    TEXT         NOT NULL,
  -- 'monitor' (record only) | 'enforce' (a blocking decision actually blocks).
  mode          TEXT         NOT NULL,
  updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- The admin (team-member id) who last set this posture, for the audit trail.
  updated_by    TEXT,
  PRIMARY KEY (workspace_id, capability),
  CONSTRAINT ogiam_enforcement_policy_mode_chk CHECK (mode IN ('monitor', 'enforce'))
);

-- Resolution reads all rows for a workspace (then caches), so index the tenant.
CREATE INDEX IF NOT EXISTS idx_ogiam_enforcement_policy_workspace
  ON ogiam_enforcement_policy (workspace_id);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 207/208.
ALTER TABLE ogiam_enforcement_policy ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS ogiam_enforcement_policy_all ON ogiam_enforcement_policy;
CREATE POLICY ogiam_enforcement_policy_all ON ogiam_enforcement_policy
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'ogiam_enforcement_policy'
       AND column_name IN ('workspace_id','capability','mode','updated_at','updated_by')
  ) = 5, 'ogiam_enforcement_policy missing expected columns';

  -- Schema-guard parity: workspace_id must be TEXT, never UUID.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'ogiam_enforcement_policy' AND column_name = 'workspace_id'
  ) = 'text', 'ogiam_enforcement_policy.workspace_id must be TEXT';

  -- RLS must be ON - a silent NOOP would defeat the tripwire.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'ogiam_enforcement_policy'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on ogiam_enforcement_policy - aborting migration 209.';
  END IF;
END $$;

COMMIT;

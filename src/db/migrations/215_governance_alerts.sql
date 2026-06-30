-- 215_governance_alerts.sql
--
-- GOVERNANCE ALERT DEDUPE LEDGER - one row per distinct governance regression.
--
-- The governance-alerts scan (src/lib/ogiam/governance-alerts.ts) runs on a
-- schedule over the OGIAM signals (red-team pass-rate history, gate decisions,
-- the ungoverned-AI-surface inventory). When a regression crosses a threshold
-- (red-team pass rate drops / a new vuln appears) or a NEW ungoverned AI surface
-- appears, it fans a notification out through the existing notifications layer
-- (src/lib/notifications/* — DB row per send + Resend) and records the condition
-- HERE so the SAME condition never re-alerts. The dedupe key is
-- (workspace_id, alert_kind, fingerprint): the fingerprint is a stable hash of
-- the specific regression (e.g. the new vuln's attack id, or the surface id), so
-- a recurring scan that sees the same condition is a no-op, while a genuinely new
-- regression alerts once.
--
-- This is the durable record of WHICH conditions we have already told the team
-- about (no data lost: the alert row + the notification rows + the analytics
-- event together reconstruct the full alert history). Workspace-scoped, so the
-- repo-wide tenant-isolation guardrail covers it; the (workspace_id, alert_kind,
-- fingerprint) UNIQUE is both the dedupe key and the scope predicate seed.
--
-- id is a deterministic TEXT key "galert_<hash>" over the dedupe tuple;
-- workspace_id is TEXT (opaque slugs, never UUID), matching the ai-surface /
-- ogiam / compliance family. Idempotent: CREATE TABLE IF NOT EXISTS + guarded
-- index. RLS enabled with a permissive (deny-by-default tripwire) policy,
-- mirroring migration 207-214. Paired 215_governance_alerts.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_governance_alerts (
  id            TEXT         PRIMARY KEY,
  workspace_id  TEXT         NOT NULL,
  -- 'redteam_passrate_drop' | 'redteam_new_vuln' | 'new_ungoverned_surface'.
  alert_kind    TEXT         NOT NULL,
  -- Stable hash of the specific regression (the dedupe key within a kind).
  fingerprint   TEXT         NOT NULL,
  severity      TEXT         NOT NULL DEFAULT 'high',
  title         TEXT         NOT NULL,
  body          TEXT,
  -- The structured evidence behind the alert (pass rates, surface id, etc.).
  metadata      JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- How many teammates the notification fanned out to (0 = recorded only).
  recipient_count INT        NOT NULL DEFAULT 0,
  first_seen_at TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  created_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_governance_alerts_kind_chk
    CHECK (alert_kind IN ('redteam_passrate_drop', 'redteam_new_vuln', 'new_ungoverned_surface')),
  CONSTRAINT instinct_governance_alerts_severity_chk
    CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  -- The dedupe key: the same condition for a workspace is recorded once.
  CONSTRAINT uq_governance_alerts_dedupe UNIQUE (workspace_id, alert_kind, fingerprint)
);

-- History read: per workspace, newest first.
CREATE INDEX IF NOT EXISTS idx_governance_alerts_workspace_created
  ON instinct_governance_alerts (workspace_id, created_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 207-214.
ALTER TABLE instinct_governance_alerts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_governance_alerts_all ON instinct_governance_alerts;
CREATE POLICY instinct_governance_alerts_all ON instinct_governance_alerts
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_governance_alerts'
       AND column_name IN ('id','workspace_id','alert_kind','fingerprint','severity','title','body','metadata','recipient_count','first_seen_at','created_at')
  ) = 11, 'instinct_governance_alerts missing expected columns';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_governance_alerts' AND column_name = 'id'
  ) = 'text', 'instinct_governance_alerts.id must be TEXT';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_governance_alerts' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_governance_alerts.workspace_id must be TEXT';

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_governance_alerts'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_governance_alerts - aborting migration 215.';
  END IF;
END $$;

COMMIT;

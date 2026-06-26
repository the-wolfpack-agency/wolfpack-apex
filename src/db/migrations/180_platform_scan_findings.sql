-- Migration 180 — platform scan findings (agent journey/health scanning)
--
-- A platform scan is an agent crawling a TARGET external platform's routes and
-- classifying each into a structured finding (bug / ux gap / broken journey /
-- security / performance). This is how an agent "familiarizes" with a client
-- platform and surfaces use-case gaps and bugs across the journey. Distinct from
-- the agent SELF-scan (instinct_agent_scans, migration 172) which introspects
-- this platform's own tool surface.
--
-- Two tables, mirroring the drift events model (175): a scan run header +
-- per-finding rows with severity/category/evidence and a review workflow.
-- Workspace-scoped; queries always filter by workspace_id.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_platform_scans (
  id             UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   TEXT         NOT NULL DEFAULT 'default',
  platform       TEXT         NOT NULL,
  base_url       TEXT         NOT NULL,
  route_count    INTEGER      NOT NULL DEFAULT 0,
  finding_count  INTEGER      NOT NULL DEFAULT 0,
  critical_count INTEGER      NOT NULL DEFAULT 0,
  triggered_by   TEXT,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS instinct_platform_scan_findings (
  id           UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_id      UUID         NOT NULL,
  workspace_id TEXT         NOT NULL DEFAULT 'default',
  platform     TEXT         NOT NULL,
  route        TEXT         NOT NULL,
  severity     TEXT         NOT NULL,
  category     TEXT         NOT NULL,
  title        TEXT         NOT NULL,
  detail       TEXT         NOT NULL DEFAULT '',
  evidence     JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Review workflow: open -> acknowledged -> resolved (mirrors approval triage).
  status       TEXT         NOT NULL DEFAULT 'open',
  decided_by   TEXT,
  decided_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT instinct_platform_scan_findings_severity_chk
    CHECK (severity IN ('critical', 'high', 'medium', 'low')),
  CONSTRAINT instinct_platform_scan_findings_category_chk
    CHECK (category IN ('bug', 'ux_gap', 'broken_journey', 'security', 'performance')),
  CONSTRAINT instinct_platform_scan_findings_status_chk
    CHECK (status IN ('open', 'acknowledged', 'resolved'))
);

-- Hot lookup: "open findings for this workspace, worst first, newest first".
-- severity sorts lexically critical<high<low<medium, so we map it in queries; the
-- index keeps the workspace/status/time access path fast regardless.
CREATE INDEX IF NOT EXISTS idx_platform_findings_ws_status
  ON instinct_platform_scan_findings (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_platform_findings_scan
  ON instinct_platform_scan_findings (scan_id);
CREATE INDEX IF NOT EXISTS idx_platform_scans_ws
  ON instinct_platform_scans (workspace_id, created_at DESC);

COMMIT;

-- 009_sites.sql — Sites projects (Instinct → wolfpack-site-template).
--
-- Stores everything needed for Max + Meghan to drag-and-drop a brief and
-- get a hosted preview URL. No data lost: every state change has a
-- corresponding event in apex_events (via trackEvent), and every deploy
-- attempt is logged to apex_site_deploys regardless of outcome.

CREATE TABLE IF NOT EXISTS apex_site_projects (
  id              TEXT PRIMARY KEY,
  client_slug     TEXT NOT NULL UNIQUE,         -- e.g. "cftr" → repo wolfpack-cftr
  display_name    TEXT NOT NULL,                -- "Cleared for Takeoff Racing"
  brief           JSONB NOT NULL,               -- the full brief (mirrors template schema)
  github_repo     TEXT,                         -- "the-wolfpack-agency/wolfpack-cftr"
  github_repo_url TEXT,
  preview_url     TEXT,                         -- latest Vercel preview URL
  status          TEXT NOT NULL DEFAULT 'draft',
  -- draft → provisioning → deploying → ready | failed
  last_deploy_id  TEXT,
  last_canary_passed BOOLEAN,
  agentic_findings JSONB DEFAULT '[]'::jsonb,
  created_by      TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_site_projects_status ON apex_site_projects(status);
CREATE INDEX IF NOT EXISTS idx_apex_site_projects_created_by ON apex_site_projects(created_by);

CREATE TABLE IF NOT EXISTS apex_site_assets (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES apex_site_projects(id) ON DELETE CASCADE,
  filename    TEXT NOT NULL,
  mime_type   TEXT NOT NULL,
  size_bytes  INTEGER NOT NULL,
  storage_url TEXT NOT NULL,                    -- where the bytes live (S3 / repo public/)
  uploaded_by TEXT NOT NULL,
  uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_site_assets_project ON apex_site_assets(project_id);

CREATE TABLE IF NOT EXISTS apex_site_deploys (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES apex_site_projects(id) ON DELETE CASCADE,
  triggered_by  TEXT NOT NULL,
  workflow_run  TEXT,                           -- GitHub Actions run id
  status        TEXT NOT NULL DEFAULT 'pending',-- pending|building|success|failed
  preview_url   TEXT,
  canary_passed BOOLEAN,
  log_excerpt   TEXT,
  started_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_apex_site_deploys_project ON apex_site_deploys(project_id);
CREATE INDEX IF NOT EXISTS idx_apex_site_deploys_status ON apex_site_deploys(status);

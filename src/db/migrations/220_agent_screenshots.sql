-- Agent/tool screenshots: a PNG captured by the screenshot engine, stored as
-- base64 in Postgres (same no-new-dependency choice as the feedback screenshot
-- store, migration 168) and served by a capability-gated, workspace-scoped
-- route. Rendering happens on Wolfpack infra; the bytes are workspace-internal.
-- Additive + idempotent.

CREATE TABLE IF NOT EXISTS instinct_agent_screenshots (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT NOT NULL,
  created_by    TEXT NOT NULL,
  source_url    TEXT NOT NULL,
  content_type  TEXT NOT NULL DEFAULT 'image/png',
  data_base64   TEXT NOT NULL,
  byte_size     INTEGER NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_screenshots_ws
  ON instinct_agent_screenshots (workspace_id, created_at DESC);

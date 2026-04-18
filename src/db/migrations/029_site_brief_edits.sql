-- 029_site_brief_edits.sql — Prompt-to-brief edit audit trail.
--
-- Every prompt-based brief edit attempt is captured here BEFORE the user
-- accepts or rejects the proposed patch. Rows flow:
--   instruction submitted → row inserted (accepted=NULL)
--   user approves in UI   → row updated (accepted=true,  decided_at=NOW)
--   user discards in UI   → row updated (accepted=false, rejection_reason, decided_at=NOW)
--   AI generates a patch that targets a blocked path (e.g. /client_slug)
--     → row inserted with accepted=false, rejection_reason='patch_blocked'
--       so the brain still sees the bad attempt and can learn from it.
--
-- No data lost — every prompt, patch, token count, latency, and decision
-- is preserved for the learning loop.

CREATE TABLE IF NOT EXISTS apex_site_brief_edits (
  id                 TEXT PRIMARY KEY,
  project_id         TEXT NOT NULL REFERENCES apex_site_projects(id) ON DELETE CASCADE,
  user_id            TEXT NOT NULL,
  user_role          TEXT NOT NULL,
  instruction        TEXT NOT NULL,
  patch              JSONB NOT NULL,
  brief_before_hash  TEXT NOT NULL,
  brief_after_hash   TEXT NOT NULL,
  accepted           BOOLEAN,                      -- NULL until user decides
  rejection_reason   TEXT,
  latency_ms         INT,
  tokens_in          INT,
  tokens_out         INT,
  cost_usd           NUMERIC(10,6),
  model              TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  decided_at         TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_brief_edits_project  ON apex_site_brief_edits(project_id);
CREATE INDEX IF NOT EXISTS idx_brief_edits_user     ON apex_site_brief_edits(user_id);
CREATE INDEX IF NOT EXISTS idx_brief_edits_accepted ON apex_site_brief_edits(accepted);

-- Instinct-name alias, mirroring the pattern in migration 014.
CREATE OR REPLACE VIEW instinct_site_brief_edits AS
  SELECT * FROM apex_site_brief_edits;

-- 031_site_brief_generations.sql — Wireframe-to-brief image generations.
--
-- Every time a user drops an image/PDF wireframe into the Sites dropzone,
-- the vision → SiteBrief round-trip lands here. Rows flow:
--   image uploaded → row inserted (project_id=NULL, accepted=NULL)
--   user commits brief into a new project → row updated with project_id
--                                           and accepted=true
--   user discards the draft              → row updated with accepted=false
--   MIME / size rejected (route level)   → analytics only, no row
--     (nothing to persist — the file never hit the model)
--
-- No data lost — every prompt (image bytes represented by sha256 +
-- mime + size), extracted brief, color palette, model, latency, and
-- decision is preserved for the learning loop.

CREATE TABLE IF NOT EXISTS apex_site_brief_generations (
  id                TEXT PRIMARY KEY,
  project_id        TEXT,                                 -- set once the brief is accepted into a project
  requested_by      TEXT NOT NULL,
  source_mime       TEXT NOT NULL,
  source_size       INTEGER NOT NULL,
  source_sha256     TEXT NOT NULL,                        -- de-dupe + audit
  extracted_brief   JSONB NOT NULL,                       -- the SiteBrief we produced
  extracted_colors  TEXT[],                               -- hex palette, primary → muted order
  detected_font     TEXT,
  model             TEXT NOT NULL,
  latency_ms        INTEGER NOT NULL,
  token_cost_cents  INTEGER,
  accepted          BOOLEAN,                              -- NULL until user commits or discards
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asbg_requested_by ON apex_site_brief_generations(requested_by);
CREATE INDEX IF NOT EXISTS idx_asbg_source_sha   ON apex_site_brief_generations(source_sha256);
CREATE INDEX IF NOT EXISTS idx_asbg_project      ON apex_site_brief_generations(project_id);
CREATE INDEX IF NOT EXISTS idx_asbg_accepted     ON apex_site_brief_generations(accepted);

-- Instinct-name alias, mirroring the pattern in migration 014.
CREATE OR REPLACE VIEW instinct_site_brief_generations AS
  SELECT * FROM apex_site_brief_generations;

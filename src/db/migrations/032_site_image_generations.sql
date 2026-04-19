-- 032_site_image_generations.sql — AI image generations for Sites.
--
-- Every time a non-technical team member clicks "Generate image" next to
-- a hero backgroundImage or gallery item src inside BriefForm, we call
-- fal.ai FLUX.1 [schnell] to produce an image, commit the bytes into the
-- client's provisioned repo (so the deployed site owns its own copy —
-- never linking to fal.ai's CDN), and persist the full request/response
-- here.
--
-- Row lifecycle:
--   request submitted → row inserted with accepted=NULL
--   user clicks "Use this image" → UPDATE sets accepted=true
--   user clicks "Try another" → previous row stays accepted=NULL (a new
--                               row is inserted for the regen), and the
--                               old row is rolled up as "dismissed" via
--                               analytics only (NULL still means in-flight
--                               from the row's perspective — the modal
--                               close handler flips accepted=false).
--   modal cancelled without accepting → accepted flips to false
--
-- NO data lost — even failed generations (4xx from fal.ai, prompt_blocked,
-- daily_cap_exceeded) insert a row so the learning loop sees which prompts
-- land vs which get rejected. image_url may be empty string on failed
-- generations so the NOT NULL constraint still holds.

CREATE TABLE IF NOT EXISTS apex_site_image_generations (
  id             TEXT PRIMARY KEY,
  project_id     TEXT,
  requested_by   TEXT NOT NULL,
  prompt         TEXT NOT NULL,
  aspect_ratio   TEXT NOT NULL,
  seed           BIGINT,
  model          TEXT NOT NULL,
  image_url      TEXT NOT NULL,
  repo_committed BOOLEAN NOT NULL DEFAULT false,
  cost_cents     INTEGER,
  latency_ms     INTEGER NOT NULL,
  accepted       BOOLEAN,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_asig_project      ON apex_site_image_generations(project_id);
CREATE INDEX IF NOT EXISTS idx_asig_requested_by ON apex_site_image_generations(requested_by);
CREATE INDEX IF NOT EXISTS idx_asig_accepted     ON apex_site_image_generations(accepted);
CREATE INDEX IF NOT EXISTS idx_asig_created_at   ON apex_site_image_generations(created_at);

-- Instinct-name alias, mirroring migration 014's convention.
CREATE OR REPLACE VIEW instinct_site_image_generations AS
  SELECT * FROM apex_site_image_generations;

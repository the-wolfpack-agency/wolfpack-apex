-- 223_releases.sql
--
-- Release notes / changelog for the /releases wiki page and the release email.
-- One row per release. `entries` is a JSONB array of feature breakdowns, each
-- { title, description, how_to_use, area, category }, written in plain English
-- so the team can read what shipped and how to use it.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS instinct_releases (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  version      TEXT NOT NULL,                      -- e.g. "2026-07-29" or a git tag
  title        TEXT NOT NULL,
  summary      TEXT NOT NULL DEFAULT '',
  released_on  DATE NOT NULL DEFAULT CURRENT_DATE,
  entries      JSONB NOT NULL DEFAULT '[]'::jsonb, -- ReleaseEntry[]
  published    BOOLEAN NOT NULL DEFAULT true,
  created_by   TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One release per version; re-publishing the same version upserts.
CREATE UNIQUE INDEX IF NOT EXISTS idx_instinct_releases_version
  ON instinct_releases (version);

-- The page lists newest first and filters by date.
CREATE INDEX IF NOT EXISTS idx_instinct_releases_released_on
  ON instinct_releases (released_on DESC);

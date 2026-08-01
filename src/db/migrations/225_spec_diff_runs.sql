-- 225_spec_diff_runs.sql
--
-- Spec-diff: every comparison of a prototype against its implementation, kept.
--
-- Converting a wireframe by eye is how a 6px header, a 63px hero and a 19px
-- heading ship as "matching the spec": the only detector is a person noticing in
-- a screenshot, so each defect costs a review cycle. Spec-diff measures both
-- pages in a browser instead, and this table is where those measurements live.
--
-- Storing runs (not just returning them) is what turns the tool into a learning
-- surface: drift per project over time, which checks actually catch things,
-- which prototypes are converted cleanly, and a durable before/after when a
-- conversion is re-run after a fix. No data lost.
--
-- Tenant model: workspace_id on every row, filtered explicitly in every query
-- (see the repo-wide tenant-isolation scan). Results are stored as JSONB because
-- the report shape is owned by the app layer (compare.ts) and evolves with it.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS instinct_spec_diff_runs (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT, not UUID: workspace ids in this schema are TEXT throughout (the
  -- workspace-id-type contract test enforces it), and the API falls back to the
  -- literal 'default' workspace, which is not a UUID.
  workspace_id   TEXT NOT NULL,
  -- What was compared. Both are external URLs, validated by the SSRF guard
  -- before any navigation happens.
  spec_url       TEXT NOT NULL,
  target_url     TEXT NOT NULL,
  -- Viewports the run measured, e.g. [{"width":1512,"height":950}]. Height is
  -- stored because a hero sized in vh matches at one window height and not
  -- another, so a report is only meaningful alongside the viewport it used.
  viewports      JSONB NOT NULL DEFAULT '[]'::jsonb,
  tolerance_px   NUMERIC NOT NULL DEFAULT 1.5,
  -- Rolled-up verdict, kept as columns so trend queries do not have to open the
  -- JSON: did anything differ, how much, and was the font itself wrong.
  clean          BOOLEAN NOT NULL DEFAULT FALSE,
  total_diffs    INT NOT NULL DEFAULT 0,
  total_missing  INT NOT NULL DEFAULT 0,
  font_mismatch  BOOLEAN NOT NULL DEFAULT FALSE,
  matched_elements INT NOT NULL DEFAULT 0,
  -- The full per-viewport report, and any viewport that failed to measure.
  results        JSONB NOT NULL DEFAULT '[]'::jsonb,
  errors         JSONB NOT NULL DEFAULT '[]'::jsonb,
  duration_ms    INT NOT NULL DEFAULT 0,
  created_by     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- The list view: one workspace's runs, newest first.
CREATE INDEX IF NOT EXISTS idx_spec_diff_runs_workspace_time
  ON instinct_spec_diff_runs (workspace_id, created_at DESC);

-- Trend for one converted page over time ("is this getting closer to the spec").
CREATE INDEX IF NOT EXISTS idx_spec_diff_runs_target
  ON instinct_spec_diff_runs (workspace_id, target_url, created_at DESC);

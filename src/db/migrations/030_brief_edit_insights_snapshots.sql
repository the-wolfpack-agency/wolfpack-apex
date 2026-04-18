-- 030_brief_edit_insights_snapshots.sql — historical snapshots of the
-- brief-edit learning-loop aggregator output.
--
-- The aggregator (src/lib/brief-edit-learning.ts) computes acceptance
-- rates, rejection reasons, blocked paths, cost/latency, section-edit
-- frequency, and instruction themes from apex_site_brief_edits. A
-- nightly CI job (scripts/brief-edit-insights-nightly.ts) invokes the
-- aggregator for 7-day and 30-day windows and writes one row per
-- window to this table, preserving the full BriefEditInsights object
-- in the payload JSONB column so we can trend any metric over time
-- without rerunning the aggregator.
--
-- No data lost: raw rows live in apex_site_brief_edits; this table is
-- purely a rolled-up materialisation for dashboards.

CREATE TABLE IF NOT EXISTS apex_brief_edit_insights_snapshots (
  id            TEXT PRIMARY KEY,
  window_start  TIMESTAMPTZ NOT NULL,
  window_end    TIMESTAMPTZ NOT NULL,
  payload       JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_brief_edit_snapshots_window_end
  ON apex_brief_edit_insights_snapshots(window_end);

-- Instinct-name alias, mirroring the pattern in migration 014.
CREATE OR REPLACE VIEW instinct_brief_edit_insights_snapshots AS
  SELECT * FROM apex_brief_edit_insights_snapshots;

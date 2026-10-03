-- Perf indexes for the site_analytics_events hot rollups.
--
-- The agent-intelligence queries filter by props->>'site' and GROUP BY
-- props->>'fp' over a growing table (up to 20k rows / per-site 1500 windows),
-- while every query also bounds created_at. With only the created_at/event_type
-- indexes those rollups seq-scan and parse JSONB per row, so loads slow and then
-- time out as the table grows. These expression btree indexes on the two
-- extracted keys (each paired with created_at, since the window bound is always
-- present) make the hot paths index-scans. Additive + idempotent.
CREATE INDEX IF NOT EXISTS idx_sae_site_created
  ON site_analytics_events ((props->>'site'), created_at);
CREATE INDEX IF NOT EXISTS idx_sae_fp_created
  ON site_analytics_events ((props->>'fp'), created_at);

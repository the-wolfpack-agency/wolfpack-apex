-- 178_site_analytics_events.sql
--
-- Usage telemetry for the OGIAM marketing site (ogiam.com), ingested into our
-- OWN platform so site usage feeds the same data + learning mechanism as
-- everything else, with no third-party analytics product. The marketing site
-- forwards its closed-vocabulary signal events to /api/site-analytics/ingest,
-- which writes one row here. The admin Site Analytics page aggregates these into
-- the reused HourHeatmap (time of day), top pages, and top countries.
--
-- PRIVACY: anonymous by construction. We store the coarse country (2-letter,
-- derived from the edge geo header) and the page path only. No IP, no user id,
-- no cookies, no PII. Aligns with the privacy-first posture.
--
-- Idempotent (CREATE ... IF NOT EXISTS + guarded indexes).

CREATE TABLE IF NOT EXISTS site_analytics_events (
  id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  event_type    TEXT NOT NULL,
  path          TEXT,
  country       TEXT,
  referrer_host TEXT,
  props         JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS site_analytics_events_created_idx
  ON site_analytics_events (created_at DESC);
CREATE INDEX IF NOT EXISTS site_analytics_events_type_idx
  ON site_analytics_events (event_type);

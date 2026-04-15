-- Migration 016: Setup wizard event capture + funnel view
--
-- Tracks every interaction in the first-run setup wizard so the
-- learning loop can compute drop-off rates and surface friction points.

CREATE TABLE IF NOT EXISTS instinct_setup_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT        NOT NULL,
  event_type     TEXT        NOT NULL CHECK (event_type IN (
                               'setup_step_viewed',
                               'setup_step_completed',
                               'setup_step_abandoned',
                               'setup_integration_connect_started',
                               'setup_integration_connect_succeeded',
                               'setup_integration_connect_failed'
                             )),
  step           TEXT        NOT NULL CHECK (step IN ('profile', 'team', 'integrations', 'complete')),
  integration    TEXT        CHECK (integration IN ('microsoft', 'quickbooks', 'plaud')),
  duration_ms    INTEGER,
  attempt_number INTEGER     NOT NULL DEFAULT 1,
  metadata       JSONB       NOT NULL DEFAULT '{}'::jsonb,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_setup_events_user_ts
  ON instinct_setup_events (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_setup_events_type_ts
  ON instinct_setup_events (event_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_setup_events_step_type
  ON instinct_setup_events (step, event_type);

-- Funnel view: one row per setup step with conversion metrics
CREATE OR REPLACE VIEW instinct_setup_funnel AS
SELECT
  step,
  COUNT(*) FILTER (WHERE event_type = 'setup_step_viewed')     AS viewed_count,
  COUNT(*) FILTER (WHERE event_type = 'setup_step_completed')  AS completed_count,
  COUNT(*) FILTER (WHERE event_type = 'setup_step_abandoned')  AS abandoned_count,
  CASE
    WHEN COUNT(*) FILTER (WHERE event_type = 'setup_step_viewed') = 0 THEN 0
    ELSE ROUND(
      COUNT(*) FILTER (WHERE event_type = 'setup_step_completed')::numeric /
      COUNT(*) FILTER (WHERE event_type = 'setup_step_viewed')::numeric,
      4
    )
  END AS completion_rate,
  PERCENTILE_CONT(0.5) WITHIN GROUP (ORDER BY duration_ms)
    FILTER (WHERE duration_ms IS NOT NULL) AS median_duration_ms
FROM instinct_setup_events
WHERE step IN ('profile', 'team', 'integrations')
GROUP BY step;

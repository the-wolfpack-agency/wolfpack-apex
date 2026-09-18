-- Agent sightings - persisted observations of an agent on a surface, so
-- attribution stops being a per-run snapshot and becomes an operator history.
--
-- One row per sighting (one agent-probe run, or a future live-traffic capture).
-- The operator_key is the durable, non-PII fingerprint (scaffolding + toolset)
-- computed at write time, so the operators board can group a consistent operator
-- across visits and surfaces. The journey / scaffolding / tools blobs are the
-- full observation, kept so a dossier can be rebuilt exactly. No PII: keys are
-- opaque fingerprints, blobs are structural features only.

CREATE TABLE IF NOT EXISTS instinct_agent_sightings (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        TEXT        NOT NULL,
  operator_key        TEXT        NOT NULL,
  surface             TEXT        NOT NULL,
  seen_at             TIMESTAMPTZ NOT NULL,
  behavior_class      TEXT        NOT NULL,
  behavior_confidence TEXT        NOT NULL,
  threat_level        TEXT        NOT NULL,
  journey             JSONB       NOT NULL DEFAULT '{}',
  scaffolding         JSONB       NOT NULL DEFAULT '{}',
  tools               JSONB       NOT NULL DEFAULT '{}',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_agent_sightings_conf_chk
    CHECK (behavior_confidence IN ('proven', 'inferred')),
  CONSTRAINT instinct_agent_sightings_threat_chk
    CHECK (threat_level IN ('benign', 'elevated', 'hostile'))
);

CREATE INDEX IF NOT EXISTS idx_agent_sightings_ws_operator
  ON instinct_agent_sightings (workspace_id, operator_key);
CREATE INDEX IF NOT EXISTS idx_agent_sightings_ws_seen
  ON instinct_agent_sightings (workspace_id, seen_at DESC);

-- Migration 140 — integration_health: persistent log of nightly probes
-- against every external service we integrate with.
--
-- Why this exists: vendor APIs break silently. A required field added
-- to a Salesforce custom object, a HubSpot scope rotation, an MS Graph
-- 401 from token revocation — none of these surface until a user fires
-- a tool and gets a 500. AgenticQA's nightly orchestrator probes each
-- integration; this table stores the result so the dashboard can show
-- "last green at T-2h" and the orchestrator can diff against the
-- last-known-good schema.
--
-- Three layers of probe map to three row types via `probe_kind`:
--   * connectivity   — single read call, confirms OAuth handshake works
--   * schema         — describe / metadata fetch, hashed for drift detect
--   * action         — sandbox-only end-to-end write (weekly, not nightly)
--
-- Per-workspace + per-vendor scoping mirrors the connector_credentials
-- table so multi-tenant deployments don't cross-pollinate health.

BEGIN;

CREATE TABLE IF NOT EXISTS integration_health (
  id              UUID         NOT NULL DEFAULT gen_random_uuid(),
  workspace_id    TEXT         NOT NULL DEFAULT 'default',
  vendor          TEXT         NOT NULL,
  probe_kind      TEXT         NOT NULL,
  object_type     TEXT,
  ok              BOOLEAN      NOT NULL,
  status_code     INTEGER,
  /* Hash of the normalized schema response. Two consecutive schema
   * probes with the same hash mean nothing drifted. */
  schema_hash     TEXT,
  /* Raw JSON envelope from the vendor (truncated to ~16KB on insert
   * by the lib). Useful for diff'ing when drift is flagged. */
  schema_payload  JSONB,
  error_message   TEXT,
  duration_ms     INTEGER      NOT NULL,
  probed_at       TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT integration_health_probe_kind_chk
    CHECK (probe_kind IN ('connectivity', 'schema', 'action'))
);

CREATE INDEX IF NOT EXISTS integration_health_workspace_vendor_idx
  ON integration_health (workspace_id, vendor, probed_at DESC);

CREATE INDEX IF NOT EXISTS integration_health_drift_idx
  ON integration_health (vendor, object_type, probed_at DESC)
  WHERE probe_kind = 'schema';

/* Compact view: latest row per (workspace, vendor, probe_kind, object).
 * Dashboards read this, not the raw table, to avoid scanning history. */
CREATE OR REPLACE VIEW integration_health_latest AS
SELECT DISTINCT ON (workspace_id, vendor, probe_kind, COALESCE(object_type, ''))
  workspace_id,
  vendor,
  probe_kind,
  object_type,
  ok,
  status_code,
  schema_hash,
  error_message,
  duration_ms,
  probed_at
FROM integration_health
ORDER BY workspace_id, vendor, probe_kind, COALESCE(object_type, ''), probed_at DESC;

COMMIT;

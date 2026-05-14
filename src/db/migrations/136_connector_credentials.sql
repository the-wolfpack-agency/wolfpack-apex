-- Migration 136 — per-tenant connector credentials
--
-- Phase-4's first cut shipped env-var-driven REST connector
-- (INSTINCT_REST_CRM_BASE_URL + INSTINCT_REST_CRM_AUTH). Works for
-- single-workspace deployments but doesn't scale to multiple client
-- pilots running in the same Vercel project.
--
-- This table holds per-workspace credentials. Each connector_name
-- (e.g. "rest-default", "hubspot", "salesforce") can have one
-- credential row per workspace. Sensitive fields land encrypted via
-- src/lib/crypto/secret-storage.ts (AES-256-GCM, v1.* token format).
--
-- A connector with no row falls back to env-var defaults (existing
-- single-workspace path keeps working). Once a row exists, it wins.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_connector_credentials (
  id              UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    TEXT         NOT NULL DEFAULT 'default',
  connector_name  TEXT         NOT NULL,
  base_url        TEXT         NOT NULL,
  -- AES-256-GCM ciphertext for the Authorization header (v1.<iv>.<tag>.<ct>).
  auth_header_enc TEXT         NOT NULL,
  -- Optional object map JSON. NOT encrypted (no secrets) but stored
  -- as TEXT to mirror the env-var format.
  object_map_json TEXT,
  is_active       BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ  NOT NULL DEFAULT now(),
  created_by      TEXT,
  CONSTRAINT instinct_connector_credentials_workspace_name_unique
    UNIQUE (workspace_id, connector_name)
);

-- Hot lookup: "active credentials for this workspace + connector."
CREATE INDEX IF NOT EXISTS idx_connector_credentials_workspace_active
  ON instinct_connector_credentials (workspace_id, connector_name)
  WHERE is_active = TRUE;

COMMENT ON TABLE  instinct_connector_credentials IS
  'Per-tenant connector configuration. auth_header_enc is AES-256-GCM-encrypted.';
COMMENT ON COLUMN instinct_connector_credentials.auth_header_enc IS
  'v1.<iv>.<tag>.<ciphertext> per src/lib/crypto/secret-storage.ts';

COMMIT;

-- 284_forcefield_tenants.sql
--
-- The multi-tenant foundation for self-serve Forcefield. Today all site-analytics
-- events sit in one global pool, distinguished only by a free-form props->>'site',
-- which is NOT real isolation. This adds:
--   1. forcefield_tenants: one row per onboarded client (its name, its public site
--      label, and the SHA-256 HASH of its ingest token - never the token itself).
--      A client presents its token at ingest; we hash + match, attribute the
--      event, and can later scope every query to the tenant.
--   2. site_analytics_events.forcefield_tenant_id: the tenant a row belongs to,
--      nullable so existing rows + the internal shared-token sites are unaffected.
--
-- Idempotent (IF NOT EXISTS + guarded index). Tokens are stored hashed so a DB
-- leak never exposes a usable credential; the raw token is shown once at issue.

CREATE TABLE IF NOT EXISTS forcefield_tenants (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name          TEXT NOT NULL,
  site_label    TEXT NOT NULL,
  token_sha256  TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One tenant per token hash; the lookup at ingest is by this hash.
CREATE UNIQUE INDEX IF NOT EXISTS forcefield_tenants_token_key ON forcefield_tenants (token_sha256);
CREATE INDEX IF NOT EXISTS forcefield_tenants_status_idx ON forcefield_tenants (status);

ALTER TABLE site_analytics_events ADD COLUMN IF NOT EXISTS forcefield_tenant_id UUID;
CREATE INDEX IF NOT EXISTS site_analytics_events_tenant_idx
  ON site_analytics_events (forcefield_tenant_id) WHERE forcefield_tenant_id IS NOT NULL;

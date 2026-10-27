-- 301_forcefield_edge.sql
--
-- Forcefield Edge: the full-protection upgrade where a site owner points their
-- domain at Forcefield Edge with one DNS record, every request passes through
-- the Forcefield engine (including the bounded request-body checks), and allowed
-- traffic is forwarded to the owner's own server.
--
-- forcefield_tenants (migration 284) gains:
--   edge_origin_url            the owner's server Edge forwards allowed traffic
--                              to (https, scheme + host only). NULL = not on Edge.
--   edge_origin_secret_sealed  the per-tenant value Edge sends as the
--                              x-forcefield-edge header, sealed at rest with
--                              src/lib/crypto/secret-storage.ts (AES-256-GCM).
--                              Never stored in the clear.
--   edge_secret_rotated_at     when that value was last issued.
--
-- forcefield_edge_hostnames (new) holds the public hostnames a tenant serves
-- through Edge. A child table rather than an array column so the PRIMARY KEY
-- guarantees one hostname can never belong to two tenants (the hostname is the
-- lookup key on every request, so ambiguity there would route one tenant's
-- traffic to another's origin). Verification state from the Vercel domain API is
-- cached here for the admin view; the per-request lookup does not depend on it.
--
-- Safe on live data: additive, nullable columns and a new table only. Idempotent.

ALTER TABLE forcefield_tenants
  ADD COLUMN IF NOT EXISTS edge_origin_url TEXT,
  ADD COLUMN IF NOT EXISTS edge_origin_secret_sealed TEXT,
  ADD COLUMN IF NOT EXISTS edge_secret_rotated_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS forcefield_edge_hostnames (
  hostname         TEXT PRIMARY KEY,
  tenant_id        UUID NOT NULL REFERENCES forcefield_tenants(id) ON DELETE CASCADE,
  verified         BOOLEAN NOT NULL DEFAULT false,
  dns_records      JSONB NOT NULL DEFAULT '[]'::jsonb,
  last_checked_at  TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Stored normalized: lowercase, no port, no trailing dot.
  CONSTRAINT forcefield_edge_hostnames_normalized CHECK (hostname = lower(hostname) AND hostname !~ '[:/ ]' AND hostname !~ '\.$')
);

CREATE INDEX IF NOT EXISTS forcefield_edge_hostnames_tenant_idx ON forcefield_edge_hostnames (tenant_id);

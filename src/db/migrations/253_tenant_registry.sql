-- Migration 253: control-plane tenant registry (OGIAM self-serve, hosted DB-per-tenant).
--
-- The durable ledger of tenants for self-serve provisioning: one row per client,
-- recording the tenant id, org name, status, and (encrypted) connection string
-- to their OWN database. Request-time DB resolution already exists in the pure
-- src/lib/db/tenant.ts (env-based, "routed" mode); this table is the PROVISIONING
-- record that self-serve signup writes and an operator (or the Neon provider)
-- fills. Ported from the proven wolfpack-ford self-serve stack (DRY).
--
-- status: pending_provision -> active -> offboarded. db_url_encrypted is NULL
-- until a database is attached (manual) or created (Neon provider). The
-- connection string is stored encrypted (AES-256-GCM via secret-storage), never
-- in plaintext, and is never returned to a client.
CREATE TABLE IF NOT EXISTS instinct_tenant_registry (
  tenant_id        text PRIMARY KEY,
  org_name         text NOT NULL,
  status           text NOT NULL DEFAULT 'pending_provision'
                     CHECK (status IN ('pending_provision','active','offboarded')),
  db_url_encrypted text,
  admin_email      text,
  created_by       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_instinct_tenant_registry_status ON instinct_tenant_registry(status);

-- 287_forcefield_tenant_shares_intel.sql
--
-- Per-tenant opt-out of the shared threat-intelligence network. Default true (a
-- tenant participates): a proven-attacker fingerprint caught on any site is an
-- OPAQUE hash (over header-name shape + classification), never customer data,
-- traffic, or identity. A tenant can set this false to neither contribute to nor
-- consume the shared list; the data-sharing boundary is documented in
-- security-and-data-handling.md.
--
-- Additive, idempotent, reversible. Decoupled from the ingest path.

ALTER TABLE forcefield_tenants ADD COLUMN IF NOT EXISTS shares_intel BOOLEAN NOT NULL DEFAULT true;

-- 289_forcefield_tenant_enforce.sql
--
-- Per-tenant enforcement toggle: lets a managed site's blocking be turned on/off
-- from the console WITHOUT a redeploy. Watch-first by default (false): a tenant
-- records and shows what it WOULD block until an operator deliberately enables
-- enforcement. The central engine consults this for a tenant-authorized request
-- before it ever returns action:"block" (see api/forcefield/observe). Decoupled
-- from the client-side FORCEFIELD_ENFORCE env and from the `status` kill-switch.
--
-- Additive, idempotent, reversible.

ALTER TABLE forcefield_tenants ADD COLUMN IF NOT EXISTS enforce_enabled BOOLEAN NOT NULL DEFAULT false;

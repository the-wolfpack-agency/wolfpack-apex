-- 288_forcefield_tenant_connector.sql
--
-- Per-tenant connector platform: which integration a tenant uses to reach the
-- engine (a site we host, Vercel, Cloudflare, WordPress, or the generic shim).
-- This drives a platform-TAILORED quick-start (only the relevant env/snippet +
-- setup steps) and the "supported platforms" catalog that is itself a selling
-- point. The adapters and the engine are unchanged; this is just the tenant's
-- chosen door. 'generic' preserves the prior both-adapters behavior, so the
-- column is backward compatible for every existing tenant.
--
-- Additive, idempotent, reversible. Decoupled from the ingest path.

ALTER TABLE forcefield_tenants ADD COLUMN IF NOT EXISTS platform TEXT NOT NULL DEFAULT 'generic';

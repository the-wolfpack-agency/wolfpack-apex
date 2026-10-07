-- 286_forcefield_tenant_billing.sql
--
-- Licensing + subscription state on a Forcefield tenant, built to serve BOTH
-- paths without a redeploy:
--   - a MANUAL license (an existing client we license directly: the operator sets
--     plan + status; billing_provider = 'manual', no Stripe), and
--   - a self-serve SaaS SUBSCRIPTION (billing_provider = 'stripe': a webhook sets
--     status + current_period_end from Stripe; billing_ref holds the Stripe id).
--
-- Deliberately DECOUPLED from the ingest/decision path: the hard entitlement kill
-- stays forcefield_tenants.status (active|disabled). These columns record the
-- commercial state and drive the admin UI + future auto-disable jobs, so turning
-- billing on never risks breaking an existing tenant. Additive + idempotent.

ALTER TABLE forcefield_tenants ADD COLUMN IF NOT EXISTS plan TEXT NOT NULL DEFAULT 'none';
-- none | starter | growth | scale | enterprise
ALTER TABLE forcefield_tenants ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'none';
-- none | trialing | active | past_due | canceled
ALTER TABLE forcefield_tenants ADD COLUMN IF NOT EXISTS billing_provider TEXT NOT NULL DEFAULT 'manual';
-- manual | stripe
ALTER TABLE forcefield_tenants ADD COLUMN IF NOT EXISTS billing_ref TEXT;
ALTER TABLE forcefield_tenants ADD COLUMN IF NOT EXISTS current_period_end TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS forcefield_tenants_subscription_idx
  ON forcefield_tenants (subscription_status) WHERE subscription_status <> 'none';

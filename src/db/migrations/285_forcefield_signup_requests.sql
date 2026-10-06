-- 285_forcefield_signup_requests.sql
--
-- Public, GATED self-serve signup for Forcefield. A prospect submits a request on
-- the public /forcefield/signup page; it lands here as a PENDING row. An operator
-- reviews it and either approves (which provisions a forcefield_tenants row + issues
-- the ingest token) or rejects it. No token is ever minted by the public request
-- itself - that is the anti-abuse boundary until billing + rate/pen-test controls
-- are in place.
--
-- This is an intake queue, not client business data: it exists BEFORE a tenant, so
-- it is keyed by nothing tenant-scoped (registered global-by-design in the
-- tenant-scoping guardrail, same posture as forcefield_tenants). The email + a hash
-- of the submitter IP are kept for dedupe, rate-analysis, and so no signal is lost.
--
-- Idempotent (IF NOT EXISTS + guarded indexes).

CREATE TABLE IF NOT EXISTS forcefield_signup_requests (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name         TEXT NOT NULL,
  email        TEXT NOT NULL,
  site_url     TEXT NOT NULL,
  note         TEXT,
  status       TEXT NOT NULL DEFAULT 'pending',   -- pending | approved | rejected
  ip_hash      TEXT,                               -- sha256 of submitter IP, for dedupe/abuse analysis
  tenant_id    UUID,                               -- set once approved -> the provisioned forcefield_tenants.id
  reviewed_by  TEXT,                               -- operator user id who approved/rejected
  reviewed_at  TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS forcefield_signup_requests_status_idx ON forcefield_signup_requests (status);
CREATE INDEX IF NOT EXISTS forcefield_signup_requests_email_idx ON forcefield_signup_requests (lower(email));
-- Collapse duplicate open requests for the same site+email so a double-submit (or a
-- retry) does not create a second pending row.
CREATE UNIQUE INDEX IF NOT EXISTS forcefield_signup_requests_open_key
  ON forcefield_signup_requests (lower(email), lower(site_url))
  WHERE status = 'pending';

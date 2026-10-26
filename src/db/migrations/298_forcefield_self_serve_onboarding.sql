-- 298_forcefield_self_serve_onboarding.sql
--
-- Self-serve Forcefield onboarding: a person adds their site, names an alert
-- address, proves they own the site, connects it, confirms the address, and
-- starts receiving that site's alerts. This extends the two tables that already
-- hold the intake and the tenant; it adds no new table.
--
-- forcefield_signup_requests (the intake, migration 285) gains:
--   kind                 'request' (the operator-reviewed queue, unchanged) or
--                        'self_serve' (the new flow, gated by ownership proof).
--   setup_key_sha256     SHA-256 of the onboarding key the browser holds between
--                        steps. The raw key is returned once and never stored.
--   ownership_method / ownership_verified_at
--                        how and when the site's ownership was proven (the
--                        platform-scan verification: well-known file or DNS TXT).
--   concierge_requested_at / concierge_note
--                        the "we'll do it for you" connect request.
--
-- forcefield_tenants (migration 284) gains the tenant's alert address and its
-- double opt-in state:
--   notify_email                 the address alerts go to once confirmed.
--   notify_status                pending | confirmed | unsubscribed (NULL = none).
--   notify_confirm_token_sha256  SHA-256 of the signed confirmation token. The
--                                token itself is only ever in the email.
--   notify_confirm_expires_at    when that token stops working.
--   notify_confirmed_at / notify_unsubscribed_at
--   first_evidence_at            when the "Forcefield is watching <site>" email
--                                was claimed (sent at most once per tenant).
--   notify_digest_sent_on        the UTC day the last daily digest was claimed.
--
-- Delivery stays behind the recipient allowlist (FORCEFIELD_RECIPIENT_DOMAINS,
-- src/lib/forcefield-web/recipient-allowlist.ts); nothing here sends anything.
--
-- Safe on live data: additive, nullable or defaulted columns and guarded
-- indexes only. Existing rows keep kind = 'request' and no alert address.
-- Idempotent (IF NOT EXISTS everywhere).

ALTER TABLE forcefield_signup_requests
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'request',
  ADD COLUMN IF NOT EXISTS setup_key_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS ownership_method TEXT,
  ADD COLUMN IF NOT EXISTS ownership_verified_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS concierge_requested_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS concierge_note TEXT;

-- The onboarding key is looked up by its hash on every step.
CREATE UNIQUE INDEX IF NOT EXISTS forcefield_signup_requests_setup_key
  ON forcefield_signup_requests (setup_key_sha256) WHERE setup_key_sha256 IS NOT NULL;
CREATE INDEX IF NOT EXISTS forcefield_signup_requests_concierge_idx
  ON forcefield_signup_requests (concierge_requested_at) WHERE concierge_requested_at IS NOT NULL;

ALTER TABLE forcefield_tenants
  ADD COLUMN IF NOT EXISTS notify_email TEXT,
  ADD COLUMN IF NOT EXISTS notify_status TEXT,
  ADD COLUMN IF NOT EXISTS notify_confirm_token_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS notify_confirm_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_confirmed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_unsubscribed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS first_evidence_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS notify_digest_sent_on DATE;

-- The notification cron reads confirmed addresses only.
CREATE INDEX IF NOT EXISTS forcefield_tenants_notify_confirmed_idx
  ON forcefield_tenants (id) WHERE notify_status = 'confirmed';

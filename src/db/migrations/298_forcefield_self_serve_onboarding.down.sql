-- Rollback for 298_forcefield_self_serve_onboarding.sql (ops-only; never run by deploy).
DROP INDEX IF EXISTS forcefield_tenants_notify_confirmed_idx;
ALTER TABLE forcefield_tenants
  DROP COLUMN IF EXISTS notify_email,
  DROP COLUMN IF EXISTS notify_status,
  DROP COLUMN IF EXISTS notify_confirm_token_sha256,
  DROP COLUMN IF EXISTS notify_confirm_expires_at,
  DROP COLUMN IF EXISTS notify_confirmed_at,
  DROP COLUMN IF EXISTS notify_unsubscribed_at,
  DROP COLUMN IF EXISTS first_evidence_at,
  DROP COLUMN IF EXISTS notify_digest_sent_on;
DROP INDEX IF EXISTS forcefield_signup_requests_concierge_idx;
DROP INDEX IF EXISTS forcefield_signup_requests_setup_key;
ALTER TABLE forcefield_signup_requests
  DROP COLUMN IF EXISTS kind,
  DROP COLUMN IF EXISTS setup_key_sha256,
  DROP COLUMN IF EXISTS ownership_method,
  DROP COLUMN IF EXISTS ownership_verified_at,
  DROP COLUMN IF EXISTS concierge_requested_at,
  DROP COLUMN IF EXISTS concierge_note;

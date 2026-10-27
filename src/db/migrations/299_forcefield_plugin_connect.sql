-- 299_forcefield_plugin_connect.sql
--
-- Two-step Forcefield onboarding: a site owner enters their website and email,
-- then clicks one install button for their platform. For WordPress the plugin
-- connects the site itself: no key to copy, no DNS record, no file upload.
--
-- forcefield_signup_requests (migrations 285 + 298) gains:
--   detected_platform     what the read-only home-page check found on signup:
--                         'wordpress' | 'vercel' | 'other' (NULL = not checked).
--   plugin_secret_sha256  SHA-256 of the random secret the WordPress plugin
--                         generated when its Connect button was clicked. The
--                         plugin presents the raw secret to prove the ownership
--                         challenge and to collect its site key; only the hash
--                         is stored.
--   plugin_linked_at      when the plugin collected its site key, after the
--                         owner clicked the sign-in link in the confirmation
--                         email. The key is issued exactly once.
--
-- ownership_method (298) gains the value 'wordpress_plugin': the plugin running
-- on the site answered a server-issued challenge. DNS TXT and the well-known
-- file stay available for every other path.
--
-- Safe on live data: additive nullable columns and a guarded index only.
-- Idempotent (IF NOT EXISTS everywhere).

ALTER TABLE forcefield_signup_requests
  ADD COLUMN IF NOT EXISTS detected_platform TEXT,
  ADD COLUMN IF NOT EXISTS plugin_secret_sha256 TEXT,
  ADD COLUMN IF NOT EXISTS plugin_linked_at TIMESTAMPTZ;

-- The plugin's prove and claim calls look the request up by the secret hash.
CREATE UNIQUE INDEX IF NOT EXISTS forcefield_signup_requests_plugin_secret
  ON forcefield_signup_requests (plugin_secret_sha256) WHERE plugin_secret_sha256 IS NOT NULL;

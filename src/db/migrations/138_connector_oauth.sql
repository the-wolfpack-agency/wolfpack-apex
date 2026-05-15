-- Migration 138 — OAuth2 token storage for connector credentials.
--
-- Why this exists: vendor presets (HubSpot, Salesforce, QuickBooks)
-- assumed a static bearer in auth_header. Real Salesforce + QBO + Jira
-- + HubSpot OAuth apps use short-lived access tokens (~2h) with
-- refresh tokens. Without storing the refresh token + expiry, every
-- connector dies overnight.
--
-- Design:
--   - auth_type discriminates between the legacy static-bearer flow
--     (existing rows, no migration needed for them) and the new oauth2
--     flow that needs refresh.
--   - auth_header_enc stays as the CURRENT usable Authorization
--     header — for OAuth, it's "Bearer <fresh-access-token>" that the
--     refresh layer transparently rotates. Existing connector code
--     that reads authHeader keeps working.
--   - refresh_token_enc + access_token_expires_at let the refresh
--     orchestrator decide when to rotate. Both nullable so static-
--     bearer rows are unaffected.
--   - oauth_provider_metadata is a JSONB sidecar for provider-specific
--     URLs (Salesforce instance_url, QBO realm_id, HubSpot portal_id)
--     so the rest-connector can compose base_url at request time
--     instead of hardcoding it at OAuth-completion time.
--
-- No silent data loss (per feedback_no_silent_data_loss):
--   * CHECK constraint pins auth_type to the supported values.
--   * Backfill explicitly sets static_bearer for existing rows.
--   * Down migration drops the columns + constraint.

BEGIN;

ALTER TABLE instinct_connector_credentials
  ADD COLUMN IF NOT EXISTS auth_type               TEXT,
  ADD COLUMN IF NOT EXISTS refresh_token_enc       TEXT,
  ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS oauth_provider_metadata JSONB;

UPDATE instinct_connector_credentials
   SET auth_type = 'static_bearer'
 WHERE auth_type IS NULL;

ALTER TABLE instinct_connector_credentials
  ALTER COLUMN auth_type SET NOT NULL,
  ALTER COLUMN auth_type SET DEFAULT 'static_bearer';

ALTER TABLE instinct_connector_credentials
  DROP CONSTRAINT IF EXISTS instinct_connector_credentials_auth_type_chk;

ALTER TABLE instinct_connector_credentials
  ADD CONSTRAINT instinct_connector_credentials_auth_type_chk
  CHECK (auth_type IN ('static_bearer','oauth2'));

-- Hot lookup: "rows expiring in the next N minutes" for proactive refresh.
-- Partial index keeps it small (static_bearer rows are excluded).
CREATE INDEX IF NOT EXISTS idx_connector_credentials_expiring
  ON instinct_connector_credentials (access_token_expires_at)
  WHERE auth_type = 'oauth2' AND access_token_expires_at IS NOT NULL;

COMMENT ON COLUMN instinct_connector_credentials.auth_type IS
  'static_bearer = legacy single-token; oauth2 = access+refresh+expiry managed by the refresh orchestrator.';
COMMENT ON COLUMN instinct_connector_credentials.refresh_token_enc IS
  'AES-256-GCM refresh token (v1.<iv>.<tag>.<ct>). Null for static_bearer.';
COMMENT ON COLUMN instinct_connector_credentials.access_token_expires_at IS
  'When the cached access token in auth_header_enc expires. Refresh layer rotates ~60s before this.';
COMMENT ON COLUMN instinct_connector_credentials.oauth_provider_metadata IS
  'Provider-specific JSON (Salesforce instance_url, HubSpot portal_id, QBO realm_id, etc).';

-- Sanity: every existing row got auth_type=static_bearer.
DO $$
DECLARE
  bad_count INT;
BEGIN
  SELECT COUNT(*) INTO bad_count
    FROM instinct_connector_credentials
   WHERE auth_type IS NULL OR auth_type = '';
  IF bad_count > 0 THEN
    RAISE EXCEPTION 'Migration 138 left % credential rows without auth_type', bad_count;
  END IF;
END$$;

COMMIT;

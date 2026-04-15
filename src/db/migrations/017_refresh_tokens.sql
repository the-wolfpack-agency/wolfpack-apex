-- Migration 017: Refresh-token store for JWT rotation
--
-- Supports short-lived access tokens (15 min) + long-lived refresh tokens
-- (7 days) with family-based revocation. Re-use of a revoked refresh token
-- revokes the entire family, detecting token theft.
--
-- Token family lifecycle:
--   login → new family_id, first refresh token row
--   /api/auth/refresh → mark old row used_at, insert new row in same family
--   theft detected → revoke entire family (revoked_at set on all rows)

CREATE TABLE IF NOT EXISTS instinct_refresh_tokens (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     TEXT        NOT NULL,
  family_id   UUID        NOT NULL,
  issued_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ,
  used_at     TIMESTAMPTZ
);

-- Fast lookup by token id (primary verify path)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_id
  ON instinct_refresh_tokens (id);

-- Fast revocation by family (theft response path)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_family
  ON instinct_refresh_tokens (family_id);

-- Fast user session lookup
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user
  ON instinct_refresh_tokens (user_id, issued_at DESC);

-- Expired + revoked cleanup (run periodically via pg_cron or manual job)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_expires
  ON instinct_refresh_tokens (expires_at);

-- 035_share_and_approvals.sql — unauthenticated share links + client
-- approval workflow for Instinct Sites.
--
-- Why two tables:
--   * apex_share_tokens — server-side record of every signed preview
--     token so we can revoke (flip revoked_at) without needing to
--     rotate the signing secret, and so access logs (last_accessed_at,
--     access_count) feed the learning loop — which clients actually
--     open the link, which ones never do, which designers ship dead
--     previews.
--   * apex_site_approvals — the load-bearing record. Drives accounts
--     receivable and dispute-avoidance. Future wave will gate
--     `triggerDeploy` on `state = 'approved'` via
--     `checkApprovalGate()` (currently always allowed; see
--     site-approvals.ts).
--
-- site_id is TEXT to match apex_site_projects.id (which is
-- `site_<uuid>`), same convention as 033_site_domains.
--
-- NO data lost: we NEVER delete rows here — tokens get revoked in
-- place, approvals are append-only. The learning loop wants the full
-- history per site so it can correlate approval latency, comment
-- sentiment, and revision cycles with downstream client health.

CREATE TABLE IF NOT EXISTS apex_share_tokens (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id            TEXT NOT NULL,
  nonce              TEXT NOT NULL UNIQUE,
  created_by         UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL,
  revoked_at         TIMESTAMPTZ,
  last_accessed_at   TIMESTAMPTZ,
  access_count       INT NOT NULL DEFAULT 0,
  CONSTRAINT apex_share_tokens_site_fk
    FOREIGN KEY (site_id) REFERENCES apex_site_projects(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS apex_share_tokens_site_idx
  ON apex_share_tokens(site_id);
CREATE INDEX IF NOT EXISTS apex_share_tokens_expires_idx
  ON apex_share_tokens(expires_at)
  WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS apex_site_approvals (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  site_id          TEXT NOT NULL,
  share_token_id   UUID,            -- null if approval came from an authed Instinct user
  state            TEXT NOT NULL,   -- pending | approved | changes_requested
  actor_name       TEXT,
  actor_email      TEXT,
  comment          TEXT,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT apex_site_approvals_site_fk
    FOREIGN KEY (site_id) REFERENCES apex_site_projects(id) ON DELETE CASCADE,
  CONSTRAINT apex_site_approvals_token_fk
    FOREIGN KEY (share_token_id) REFERENCES apex_share_tokens(id) ON DELETE SET NULL,
  CONSTRAINT apex_site_approvals_state_chk
    CHECK (state IN ('pending', 'approved', 'changes_requested'))
);

CREATE INDEX IF NOT EXISTS apex_site_approvals_site_idx
  ON apex_site_approvals(site_id, created_at DESC);
CREATE INDEX IF NOT EXISTS apex_site_approvals_state_idx
  ON apex_site_approvals(site_id, state);

-- Instinct-name aliases, mirroring the convention used in 014/033 so
-- readers can query without knowing about the apex_ legacy prefix.
CREATE OR REPLACE VIEW instinct_share_tokens AS
  SELECT * FROM apex_share_tokens;

CREATE OR REPLACE VIEW instinct_site_approvals AS
  SELECT * FROM apex_site_approvals;

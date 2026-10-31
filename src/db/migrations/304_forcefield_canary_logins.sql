-- 304_forcefield_canary_logins.sql
--
-- Canary logins: a decoy kind "login" (a fake service sign-in planted where only
-- a harvester looks; using it at a sign-in form is proof). Widens the kind check
-- on instinct_forcefield_canaries, and indexes:
--   - the exact username lookup a sign-in check makes (kind, value);
--   - idempotent minting: one login canary per (workspace, seeded_in), where
--     seeded_in names the site, the decoy and the session it was served to.
-- Safe on live data: existing rows keep their kinds. Idempotent.

ALTER TABLE instinct_forcefield_canaries DROP CONSTRAINT IF EXISTS instinct_forcefield_canaries_kind_chk;
ALTER TABLE instinct_forcefield_canaries ADD CONSTRAINT instinct_forcefield_canaries_kind_chk
  CHECK (kind IN ('token', 'route', 'row', 'tool', 'login'));

CREATE INDEX IF NOT EXISTS idx_forcefield_canaries_kind_value
  ON instinct_forcefield_canaries (kind, value);

CREATE UNIQUE INDEX IF NOT EXISTS uq_forcefield_canaries_login_seed
  ON instinct_forcefield_canaries (workspace_id, seeded_in) WHERE kind = 'login';

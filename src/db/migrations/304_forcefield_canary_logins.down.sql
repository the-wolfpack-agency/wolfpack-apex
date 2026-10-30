-- Reverses 304_forcefield_canary_logins.sql. Login canaries are removed first so
-- the narrower kind check can be restored.
DROP INDEX IF EXISTS uq_forcefield_canaries_login_seed;
DROP INDEX IF EXISTS idx_forcefield_canaries_kind_value;
DELETE FROM instinct_forcefield_canaries WHERE kind = 'login';
ALTER TABLE instinct_forcefield_canaries DROP CONSTRAINT IF EXISTS instinct_forcefield_canaries_kind_chk;
ALTER TABLE instinct_forcefield_canaries ADD CONSTRAINT instinct_forcefield_canaries_kind_chk
  CHECK (kind IN ('token', 'route', 'row', 'tool'));

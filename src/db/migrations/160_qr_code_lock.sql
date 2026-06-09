-- 160_qr_code_lock.sql
--
-- Deletion-lock for QR campaigns. A "campaign" is a row in
-- instinct_qr_codes (a /q/<slug> short link with optional UTM). Codes
-- get printed onto real-world assets, so an accidental Archive is
-- expensive: the printed code goes dead. `locked` protects an active
-- campaign — the redirect/scan path ignores it (lock is orthogonal to
-- archived_at), but the admin API refuses to Archive a locked code
-- until it is explicitly unlocked.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS. Additive only.

ALTER TABLE instinct_qr_codes
  ADD COLUMN IF NOT EXISTS locked BOOLEAN NOT NULL DEFAULT FALSE;

-- Locked, still-active campaigns are the ones we guard hardest; a
-- partial index keeps the "protected campaigns" filter cheap.
CREATE INDEX IF NOT EXISTS idx_qr_codes_locked
  ON instinct_qr_codes (created_by_user_id)
  WHERE locked = TRUE AND archived_at IS NULL;

-- Migration 134 — Invite expiration window
--
-- instinct_invites had no expires_at column; pending invites lived
-- forever. UX-wise the Wolfpack team reported invites "may have
-- expired" because the email rotted out of the inbox / the user
-- couldn't tell which token was current. Adding an explicit
-- expiration window:
--
--   1. Makes the "is this still valid?" question deterministic.
--   2. Lets the accept-invite handler return a clear 410 GONE with
--      a UI hint ("ask your admin to resend") instead of a generic
--      404.
--   3. Keeps the deployment safe (any unconsumed invite older than
--      the window is a dormant credential — capping it is a tiny
--      security win).
--
-- Default window is 30 days from creation, chosen to comfortably
-- cover a wolfpack-sized team's sign-up cadence. Existing pending
-- invites are extended to 30 days from THIS migration's runtime so
-- nobody who was mid-onboard gets locked out.

BEGIN;

ALTER TABLE instinct_invites
  ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ;

-- Default for new rows
ALTER TABLE instinct_invites
  ALTER COLUMN expires_at SET DEFAULT (NOW() + interval '30 days');

-- Backfill existing pending invites so Max + anyone else who hadn't
-- accepted gets a fresh 30-day window starting now.
UPDATE instinct_invites
   SET expires_at = NOW() + interval '30 days'
 WHERE status = 'pending'
   AND expires_at IS NULL;

-- Backfill any accepted/expired rows to their accepted_at (or now)
-- so we never have NULL expires_at after this migration.
UPDATE instinct_invites
   SET expires_at = COALESCE(accepted_at, created_at, NOW())
 WHERE expires_at IS NULL;

ALTER TABLE instinct_invites
  ALTER COLUMN expires_at SET NOT NULL;

CREATE INDEX IF NOT EXISTS idx_instinct_invites_pending_not_expired
  ON instinct_invites (expires_at)
  WHERE status = 'pending';

COMMIT;

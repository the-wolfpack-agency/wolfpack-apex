-- 207_release_gate_notifications.sql
--
-- RELEASE-GATE NOTIFICATION DEDUPE ledger.
--
-- The release-gate cron (src/lib/deploy/release-gate-notify.ts, called by
-- /api/cron/release-gate-check) runs on a schedule. Each run reads the live
-- release gate (src/lib/deploy/release-gate.ts) and, for every change that has
-- been blocking production past a threshold, notifies the responsible person
-- (PR author + admins) in-app + by email. Without a dedupe record the SAME PR
-- in the SAME state would be re-notified on EVERY cron tick - the exact noise
-- that trains people to ignore the channel, which is how a PR blocked prod for
-- 19h with no actioned signal.
--
-- Why a dedicated table and not the in-app notify() dedup:
--   in-app dedup (src/lib/notifications/in-app.ts) keys on
--   (source, source_id, user_id) and only suppresses while a notification is
--   still UNREAD. That is per-recipient and resets the moment someone reads the
--   bell. We need a SYSTEM-WIDE, recipient-independent cooldown keyed on
--   (pr_number, state): notify once per (pr_number, state) per cooldown window
--   regardless of who reads what. A state CHANGE (e.g. checks_running ->
--   checks_failing) is a NEW, notifiable event - the row's last_state tracks
--   that so a genuine escalation re-fires while a steady-state block stays quiet.
--
-- Schema guard: id is TEXT (opaque "rgn_<pr>_<state>"), NOT UUID, matching the
-- platform-scan / cross-scan family (migrations 203 / 205 / 206 and their
-- schema-guard tests). A UUID column would 500 on every real write.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded indexes. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 205 / 206.
-- Paired 207_release_gate_notifications.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_release_gate_notifications (
  -- Opaque stable key "rgn_<pr_number>_<state>": one row per logical
  -- (pr, state) so the cooldown read is a single PK lookup and a re-notify is
  -- an UPSERT that refreshes notified_at.
  id           TEXT         PRIMARY KEY,
  pr_number    INT          NOT NULL,
  -- The gate state we last notified for (awaiting_approval | checks_running |
  -- checks_failing | merge_conflict | ready_to_merge). A change of state is a
  -- new notifiable event.
  last_state   TEXT         NOT NULL,
  notified_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Cooldown lookup: the notifier reads recent rows for a pr_number to decide
-- whether the current (pr, state) was already notified inside the window.
CREATE INDEX IF NOT EXISTS idx_release_gate_notifications_pr
  ON instinct_release_gate_notifications (pr_number);

-- Recency scan: "what did we notify in the last N minutes" newest-first.
CREATE INDEX IF NOT EXISTS idx_release_gate_notifications_notified_at
  ON instinct_release_gate_notifications (notified_at DESC);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 205/206.
ALTER TABLE instinct_release_gate_notifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_release_gate_notifications_all ON instinct_release_gate_notifications;
CREATE POLICY instinct_release_gate_notifications_all ON instinct_release_gate_notifications
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_release_gate_notifications'
       AND column_name IN ('id','pr_number','last_state','notified_at')
  ) = 4, 'instinct_release_gate_notifications missing expected columns';

  -- Schema-guard parity: id must be TEXT, never UUID.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_release_gate_notifications' AND column_name = 'id'
  ) = 'text', 'instinct_release_gate_notifications.id must be TEXT';

  -- pr_number must be an integer so cooldown math + analytics stay numeric.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_release_gate_notifications' AND column_name = 'pr_number'
  ) = 'integer', 'instinct_release_gate_notifications.pr_number must be INT';

  -- RLS must be ON - a silent NOOP would defeat the tripwire.
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_release_gate_notifications'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_release_gate_notifications - aborting migration 207.';
  END IF;
END $$;

COMMIT;

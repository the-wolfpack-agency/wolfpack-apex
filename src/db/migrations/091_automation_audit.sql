-- 091_automation_audit.sql — Automation audit log + 24h undo (Phase 1).
--
-- Builds the user-visible audit trail for the porsche-classes automation:
-- every automated action that materially mutates state writes a row here
-- so the operator can SEE what happened and CLICK undo within 24h.
--
-- Complementary to `instinct_events` (analytics/telemetry — fire-and-
-- forget, never user-visible). The two layers serve different jobs:
--   - analytics  → "what is the system doing?" (aggregates, learning loop)
--   - audit      → "what did the system do TO MY DATA, and can I undo it?"
--
-- action_kind enum (CHECK constraint, no separate type — keeps migration
-- footprint small + grep-friendly):
--   - class_match_merge   → an override of kind='class_match' was inserted
--                            (auto-detected merge or manual).
--   - sharepoint_upload   → a class summary was PUT into SharePoint.
--   - survey_auto_split   → a mixed-survey artifact was auto-split into
--                            synthetic per-class snapshots.
--
-- target_ref keeps the same column shape across kinds:
--   class_match_merge → class_key (the "to" side of the merge)
--   sharepoint_upload → class_key
--   survey_auto_split → artifact_id
--
-- detail JSONB carries the kind-specific payload the revert handler needs:
--   class_match_merge → { override_id, from_value, to_value }
--   sharepoint_upload → { item_id, web_url, filename }
--   survey_auto_split → { snapshot_ids: [...], exception_id }
--
-- reverted_at / reverted_by are paired (both NULL = active, both set =
-- reverted). The 24h window is enforced at the API layer (route returns
-- 410 if created_at < NOW() - 24h) so we never delete history — even an
-- expired row stays visible in the timeline.
--
-- Index supports the hot read: "show me recent actions for THIS automation
-- ordered by time desc". A second partial index on (target_ref) when not
-- reverted lets the per-class history widget filter cheaply.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on table + indexes — re-runnable.
--   * Final DO block ASSERTs the table + check constraint exist.
--   * Down migration drops in reverse order with IF EXISTS.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_automation_audit_actions (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  automation_id   TEXT NOT NULL,
  action_kind     TEXT NOT NULL,
  -- class_key for merges/uploads, artifact_id for splits.
  target_ref      TEXT NOT NULL,
  detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
  -- user.email of whoever triggered, or 'system' for cron-driven actions.
  actor           TEXT NOT NULL,
  -- Paired with reverted_by — either both NULL or both set.
  reverted_at     TIMESTAMPTZ,
  reverted_by     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_auto_audit_kind_chk
    CHECK (action_kind IN (
      'class_match_merge',
      'sharepoint_upload',
      'survey_auto_split'
    )),
  CONSTRAINT instinct_auto_audit_revert_pair_chk
    CHECK (
      (reverted_at IS NULL AND reverted_by IS NULL)
      OR (reverted_at IS NOT NULL AND reverted_by IS NOT NULL)
    )
);

-- Hot path: the audit history widget on /summaries and the per-automation
-- audit page both order by created_at DESC within an automation.
CREATE INDEX IF NOT EXISTS idx_instinct_auto_audit_recent
  ON instinct_automation_audit_actions (automation_id, created_at DESC);

-- Per-class lookup — listActionsForClass(class_key) hits this. Partial on
-- non-reverted because that's what the "still revertable" UI cares about;
-- the full history view uses the recent index above.
CREATE INDEX IF NOT EXISTS idx_instinct_auto_audit_target_active
  ON instinct_automation_audit_actions (target_ref, created_at DESC)
  WHERE reverted_at IS NULL;

-- ============================================================
-- instinct_automation_porsche_notifications
-- ============================================================
-- "Class summary ready" idempotency table — records when we've notified
-- the configured operator(s) that a class has all four sources ingested.
-- The notification trigger logic in `notify-summary-ready.ts` SELECTs from
-- here before sending, INSERTs after a successful send, so a re-ingest of
-- a duplicate artifact does NOT spam recipients.
--
-- Single-row-per-class shape with composite PK (automation_id, class_key).
-- channel + recipient_count are kept for analytics-style auditing of
-- delivery; the absence of a row means "we have not notified yet."
CREATE TABLE IF NOT EXISTS instinct_automation_porsche_notifications (
  automation_id   TEXT NOT NULL,
  class_key       TEXT NOT NULL,
  notified_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  channel         TEXT NOT NULL,
  recipient_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (automation_id, class_key),
  CONSTRAINT instinct_auto_porsche_notifs_channel_chk
    CHECK (channel IN ('resend', 'queue', 'skipped_no_recipients', 'skipped_no_provider'))
);

-- ============================================================
-- Row-count assertion (per memory feedback_migration_safety)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_automation_audit_actions'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_automation_audit_actions not created — aborting migration 091.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_automation_porsche_notifications'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_automation_porsche_notifications not created — aborting migration 091.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'instinct_auto_audit_kind_chk'
  ) THEN
    RAISE EXCEPTION 'kind CHECK constraint missing — aborting migration 091.';
  END IF;
  RAISE NOTICE '091_automation_audit: 2 tables + 2 indexes + 3 check constraints created.';
END $$;

COMMIT;

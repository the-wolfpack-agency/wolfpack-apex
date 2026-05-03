-- 130_artifact_dedup_keys.sql — fix the false-positive duplicate bug
-- caused by the legacy (source_message_id, content_sha256) artifact
-- dedup key.
--
-- WHY: source_message_id was the Microsoft Graph mailbox-scoped message
-- id (e.g. AAMkAGI..., re-issued whenever a mailbox is migrated and
-- different across mailbox bases when the same message is delivered to
-- multiple recipients via AUTOMATION_POLL_MAILBOX_UPNS). content_sha256
-- alone collides between weekly reports that happen to share an
-- attachment name + structure but contain genuinely-different rosters
-- (because xlsx serialization is deterministic for the same input).
--
-- The new model:
--   * `internet_message_id` TEXT — the RFC 5322 Message-Id header, the
--     globally-unique-per-message id from the email standard. This is
--     the same value across mailboxes and survives mailbox migrations.
--   * `dedup_key` TEXT — the SECONDARY key the orchestrator computes
--     when internet_message_id is missing (very rare, but happens for
--     direct uploads + some Graph corner cases). Format documented in
--     `src/lib/automations/dedup.ts`.
--   * UNIQUE INDEX on (automation_id, dedup_key) — the new idempotency
--     contract. Per-automation scoping protects automations from
--     polluting each other's dedup space.
--
-- We KEEP the legacy (source_message_id, content_sha256) UNIQUE index
-- for one release window so any in-flight ingest racing with the
-- migration still no-ops idempotently. Drop it in a follow-up after
-- the new key has been live for >1 week. Tagged
-- `// TODO(2026-Q3): drop legacy dedup index in migration 131+ after
--  2026-06-01.` in src/lib/automations/porsche-classes/ingest.ts.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on every column + index — re-runnable on partial applies.
--   * Backfill DO block populates dedup_key for every existing row so
--     the new UNIQUE index can be created without a constraint violation.
--   * Final DO block ASSERTs the new column + new index exist.

BEGIN;

ALTER TABLE instinct_automation_porsche_artifacts
  ADD COLUMN IF NOT EXISTS internet_message_id TEXT;

ALTER TABLE instinct_automation_porsche_artifacts
  ADD COLUMN IF NOT EXISTS dedup_key TEXT;

-- Backfill dedup_key for existing rows. Use COALESCE(source_message_id,
-- content_sha256)+sha as a stable migration-time value: the new
-- production code path will recompute the canonical dedup_key from
-- (internet_message_id) or the secondary tuple on every future ingest,
-- but historical rows need SOMETHING here for the UNIQUE index to be
-- creatable. Per-row SHA-prefixed value guarantees uniqueness for the
-- backfill (no two existing rows can collide because the legacy index
-- was already UNIQUE on (source_message_id, content_sha256)).
DO $$
BEGIN
  UPDATE instinct_automation_porsche_artifacts
     SET dedup_key = 'legacy:' || COALESCE(source_message_id, '') || '|' || content_sha256
   WHERE dedup_key IS NULL;
END $$;

-- Now make dedup_key NOT NULL — every row has a value, no future row
-- should be inserted without one.
ALTER TABLE instinct_automation_porsche_artifacts
  ALTER COLUMN dedup_key SET NOT NULL;

-- New canonical idempotency index. Per-automation scope keeps automation
-- registries isolated.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_auto_porsche_artifacts_dedup_key
  ON instinct_automation_porsche_artifacts (automation_id, dedup_key);

-- Index for diagnostic lookups by internet_message_id (e.g.
-- "did we ever see this RFC-5322 message id?").
CREATE INDEX IF NOT EXISTS idx_instinct_auto_porsche_artifacts_imid
  ON instinct_automation_porsche_artifacts (internet_message_id)
  WHERE internet_message_id IS NOT NULL;

-- ============================================================
-- Row-count assertion (per memory feedback_migration_safety)
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM information_schema.columns
     WHERE table_name = 'instinct_automation_porsche_artifacts'
       AND column_name = 'dedup_key'
  ) THEN
    RAISE EXCEPTION 'dedup_key column missing — aborting migration 130.';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
     WHERE indexname = 'uq_instinct_auto_porsche_artifacts_dedup_key'
  ) THEN
    RAISE EXCEPTION 'unique dedup_key index missing — aborting migration 130.';
  END IF;
  RAISE NOTICE '130_artifact_dedup_keys: column + indexes in place.';
END $$;

COMMIT;

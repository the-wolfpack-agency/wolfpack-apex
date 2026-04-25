-- 090_automation_porsche_config.sql — Operator-managed config store for the
-- porsche-classes automation.
--
-- Why a key/value table instead of a typed schema: the wizard at
-- /automations/porsche-classes/setup writes two unrelated payload shapes
-- ('inbox_filters' and 'sharepoint'), each is a small JSON document with
-- different fields, and we want a single audit pattern (updated_by /
-- updated_at) for both. A single-row-per-key table keeps the writes
-- idempotent (UPSERT on key) and gives us a stable read API
-- (`SELECT value WHERE key=$1`) for the config-repo helper.
--
-- Stored payloads:
--   key='inbox_filters'  value={"sender_match": string[],
--                               "subject_match": string[]}
--     — overrides the static array in
--       src/lib/automations/porsche-classes/index.ts. Wired via a
--       loadInboxFilters() async resolver on the AutomationDefinition.
--
--   key='sharepoint'     value={"site_id": string, "drive_id": string,
--                               "path": string}
--     — preferred over the INSTINCT_SHAREPOINT_* env vars when present
--       (sharepoint-upload.ts reads config-repo first, env as fallback).
--
-- Audit: every write captures `updated_by` (the operator's email per
-- requireCapability) plus `updated_at`. Combined with the analytics
-- events the API route emits, this is the audit trail.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT wraps every statement.
--   * IF NOT EXISTS on the table and constraints — re-runnable.
--   * Final DO block ASSERTs the table exists.
--   * Paired down migration in 090_automation_porsche_config.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_automation_porsche_config (
  -- Stable string slug — today 'inbox_filters' or 'sharepoint'. Adding a
  -- third payload (e.g. 'anthropic_keys' if we ever stop using env) is a
  -- new row, not a schema change.
  key         TEXT PRIMARY KEY,
  -- Free-form JSON document. Validated at the typescript layer
  -- (src/lib/automations/porsche-classes/config-repo.ts) so the DB just
  -- stores opaque JSON.
  value       JSONB NOT NULL,
  -- Email / display label of the operator who wrote this row. Required
  -- so every change is auditable to a real human; the API route reads
  -- this from auth.user.email.
  updated_by  TEXT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Row-count assertion — every key in this allow-list must be a TEXT key
-- (no integer / uuid mix). Catches a schema drift where the table got
-- recreated with the wrong column type.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_automation_porsche_config'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION 'instinct_automation_porsche_config not created — aborting migration 090.';
  END IF;
  RAISE NOTICE '090_automation_porsche_config: table created.';
END $$;

COMMIT;

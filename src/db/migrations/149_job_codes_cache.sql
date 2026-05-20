-- Migration 149 — instinct_job_codes_cache
--
-- Read-through cache for the Wolfpack Job Codes spreadsheet that lives
-- in SharePoint. The user-chosen architecture (2026-05-20) is:
--   - SharePoint xlsx is the SINGLE source of truth
--   - Instinct never edits the codes in-app (read-only sync)
--   - Every code lookup (page render, TimeLogWidget autocomplete) hits
--     this table so we don't pay the Graph latency on the hot path
--   - A scheduled / on-demand refresh re-pulls from SharePoint via the
--     app-only Graph token and atomically replaces the cache rows.
--
-- Row identity is the (lowercased) code itself — codes are short
-- billing-style identifiers (WOLFPACK-AUTO, CLIENT-ACME). The unique
-- index gives us idempotent UPSERT semantics for the refresh path.
--
-- `last_seen_at` is the timestamp of the most recent successful refresh
-- that observed this code. Rows whose `last_seen_at` is older than the
-- current refresh batch's `started_at` represent codes that were
-- DELETED from the source workbook — refresh sets `active=false` on
-- those so the dropdown stops surfacing them but historical
-- time_entries that reference them keep their attribution.
--
-- `instinct_job_codes_refresh` records every refresh attempt so the UI
-- can surface "last synced ago" and the learning loop can see how
-- often Graph fails / serves stale.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_job_codes_cache (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  sheet_name      TEXT NOT NULL DEFAULT '',
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  source_drive_id TEXT,
  source_item_id  TEXT,
  source_web_url  TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_job_codes_code_lower
  ON instinct_job_codes_cache (LOWER(code));

CREATE INDEX IF NOT EXISTS ix_instinct_job_codes_active
  ON instinct_job_codes_cache (active) WHERE active = TRUE;

CREATE TABLE IF NOT EXISTS instinct_job_codes_refresh (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  finished_at  TIMESTAMPTZ,
  status       TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'served_stale')),
  /* Discriminates between manual admin-triggered refresh, automatic
     stale-cache refresh, and a scheduled cron tick — useful for the
     learning loop to distinguish "user pressed Refresh" from
     "background TTL expiry." */
  source       TEXT NOT NULL CHECK (source IN ('manual', 'auto_stale', 'scheduled')),
  triggered_by UUID,
  rows_seen    INT NOT NULL DEFAULT 0,
  rows_added   INT NOT NULL DEFAULT 0,
  rows_updated INT NOT NULL DEFAULT 0,
  rows_deactivated INT NOT NULL DEFAULT 0,
  error_code   TEXT,
  error_detail TEXT
);

CREATE INDEX IF NOT EXISTS ix_instinct_job_codes_refresh_started_at
  ON instinct_job_codes_refresh (started_at DESC);

COMMIT;

-- 218_invoice_tracker_cache.sql
--
-- Read-only cache for the Invoice Trackers (SharePoint workbooks mirrored under
-- the "Invoices" tab; PCNA is the first). One snapshot row per tracker id.
--
-- Not workspace-scoped on purpose: each tracker mirrors a single EXTERNAL file
-- and is gated by a per-tracker viewer allowlist at the API layer
-- (lib/invoice-tracker/config.ts), not by workspace. Storing the full sheet as
-- JSONB keeps the mirror generic (arbitrary invoice/budget columns) without a
-- schema migration per company. No data lost: every refresh attempt updates the
-- last_attempt_* columns and emits an analytics event.
--
-- Idempotent (IF NOT EXISTS + guarded indexes); paired .down.sql provided.

CREATE TABLE IF NOT EXISTS instinct_invoice_tracker_cache (
  tracker_id           TEXT        PRIMARY KEY,
  columns              JSONB       NOT NULL DEFAULT '[]'::jsonb,
  rows                 JSONB       NOT NULL DEFAULT '[]'::jsonb,
  source_drive_id      TEXT,
  source_item_id       TEXT,
  source_web_url       TEXT,
  sheet_name           TEXT,
  last_refreshed_at    TIMESTAMPTZ,           -- last SUCCESSFUL pull
  last_attempted_at    TIMESTAMPTZ,           -- last attempt (success or fail)
  last_attempt_status  TEXT,                  -- succeeded | failed | served_stale
  last_attempt_error   TEXT,
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_invoice_tracker_cache_refreshed
  ON instinct_invoice_tracker_cache (last_refreshed_at DESC);

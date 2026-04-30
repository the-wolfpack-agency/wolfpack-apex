-- 110_qr_codes.sql — QR generator + per-scan analytics.
--
-- Two-table design:
--   instinct_qr_codes  — one row per QR code (slug, target URL, owner,
--                        UTM campaign, optional expiry, archive flag).
--   instinct_qr_scans  — one row per scan event (geo, device, referrer,
--                        visitor hash). Append-only; never updated.
--
-- The redirect endpoint at /q/[slug] looks up the active code and
-- inserts a scan row before issuing the 302. Analytics queries roll up
-- instinct_qr_scans by (code_id, day, country, device).
--
-- Defensive guards: BEGIN/COMMIT, IF NOT EXISTS on every object,
-- final ASSERT, paired .down.sql with reverse-order drops.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_qr_codes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT NOT NULL UNIQUE,
  target_url TEXT NOT NULL,
  label TEXT,
  utm_campaign TEXT,
  /* When set, the redirect endpoint refuses to forward and records a
     scan with `expired = true`. */
  expires_at TIMESTAMPTZ,
  archived_at TIMESTAMPTZ,
  created_by_user_id TEXT,
  created_by_user_role TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_qr_codes_slug
  ON instinct_qr_codes (slug)
  WHERE archived_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_qr_codes_owner
  ON instinct_qr_codes (created_by_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS instinct_qr_scans (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  code_id UUID NOT NULL REFERENCES instinct_qr_codes(id) ON DELETE CASCADE,
  scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  /* Hashed visitor fingerprint — IP+UA SHA256 — never raw IP. */
  visitor_hash TEXT,
  /* Geo from request edge headers (Vercel `request.geo`). All optional. */
  country TEXT,
  region TEXT,
  city TEXT,
  /* Parsed user-agent class (mobile/tablet/desktop/bot). */
  device TEXT,
  os TEXT,
  browser TEXT,
  /* Best-effort referrer header. Often empty for QR scans (deep link
     from a camera app), but populated when the user followed a link. */
  referrer TEXT,
  /* True when the scan hit an expired or archived code. Recorded so
     analytics can report "stale fan-out". */
  blocked BOOLEAN NOT NULL DEFAULT FALSE
);

CREATE INDEX IF NOT EXISTS idx_qr_scans_code_time
  ON instinct_qr_scans (code_id, scanned_at DESC);

CREATE INDEX IF NOT EXISTS idx_qr_scans_country
  ON instinct_qr_scans (code_id, country);

CREATE INDEX IF NOT EXISTS idx_qr_scans_device
  ON instinct_qr_scans (code_id, device);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_qr_codes'
  ) >= 11, 'instinct_qr_codes missing columns';
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_qr_scans'
  ) >= 11, 'instinct_qr_scans missing columns';
END $$;

COMMIT;

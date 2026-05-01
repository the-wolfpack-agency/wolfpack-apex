-- 112_qr_scans_extended.sql — extend instinct_qr_scans with deeper attribution.
--
-- Wolfpack feedback (2026-04-30): "QR detail should display all associated
-- data pulled from QR link use." When the team opens a QR code's analytics
-- they need to be able to tell whether their CLIENT scanned it. That means
-- capturing every datapoint the public scan endpoint can see — language,
-- precise lat/lng (Vercel Pro edge headers), UTM parameters preserved
-- through redirects, screen size, timezone, bot flag, and a heuristic
-- match against instinct_clients.
--
-- Migration 110 already shipped to main and to production. We must NEVER
-- alter or rewrite it. Instead this migration EXTENDS instinct_qr_scans
-- with `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`.
--
-- Privacy note: NO raw IP addresses. The visitor_hash from migration 110
-- remains the only identity primitive. lat/lng come from Vercel's edge
-- headers (already coarse to ~city granularity) and are stored only when
-- they correlate with a client match — they are not used to track a
-- visitor across sessions because the visitor_hash hashes ip+ua and
-- expires with each network change.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT.
--   * IF NOT EXISTS on every column add and index.
--   * Final DO block ASSERTs structure.
--   * Paired .down.sql drops in reverse with IF EXISTS.
--   * Re-runnable: every ALTER is idempotent so running 112 twice is a
--     no-op (verified in scans.test.ts via a parameterized re-run).

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- Extended attribution columns on instinct_qr_scans
-- ============================================================

-- Browser language. First value of Accept-Language (e.g. "en-US"). Helps
-- distinguish a French-speaking visitor on a US edge node from a real
-- US visitor when geo alone is ambiguous.
ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS language TEXT;

-- Client tz offset in minutes. Only populated when the redirect previously
-- forwarded with `?tz=...`. Optional; many scans will leave this NULL.
ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS timezone_offset_minutes INT;

-- Screen size as "WxH". Only populated when the request URL carried `?s=`.
-- Useful for detecting a desktop scan from a phone (rare → suspicious /
-- screen-share scenario) vs a phone from a phone (the common case).
ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS screen_size TEXT;

-- Bot flag. Set whenever the UA matches /bot|crawler|spider|preview/i.
-- Distinct from the existing `device='bot'` because preview-fetchers
-- (Slack, iMessage) match `preview` but identify as desktop browsers.
ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS is_bot BOOLEAN NOT NULL DEFAULT FALSE;

-- UTM parameters parsed from the INCOMING request URL. The QR code's own
-- utm_campaign is recorded on instinct_qr_codes; these columns capture
-- what was on the URL the visitor arrived at, so a code shared on
-- LinkedIn that already carries `?utm_source=linkedin` can be attributed
-- to the upstream channel.
ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS utm_source TEXT;

ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS utm_medium TEXT;

ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS utm_campaign TEXT;

-- Lat / lng from Vercel edge headers `x-vercel-ip-latitude` /
-- `x-vercel-ip-longitude`. Vercel returns these on the Pro plan only;
-- falls back to NULL on Hobby. Stored as TEXT to preserve the exact
-- string Vercel returned (no rounding).
ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS latitude TEXT;

ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS longitude TEXT;

-- Postal code from `x-vercel-ip-postal-code`. ZIP for US, postal code for
-- other countries.
ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS postal_code TEXT;

-- Heuristic match against instinct_clients. NULL when no client correlates,
-- otherwise the matched id + a 0..1 score. The score encodes which signals
-- aligned (referrer host, city, state) so the UI can show "weak match"
-- vs "strong match".
ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS client_id TEXT;

ALTER TABLE instinct_qr_scans
  ADD COLUMN IF NOT EXISTS client_match_score NUMERIC(3, 2);

-- Index for the per-scan-list query (covers the dashboard's "all scans"
-- modal which selects every column ordered by scanned_at DESC).
CREATE INDEX IF NOT EXISTS idx_qr_scans_visitor
  ON instinct_qr_scans (code_id, visitor_hash, scanned_at DESC);

-- ============================================================
-- Structure assertions
-- ============================================================
DO $$
DECLARE
  expected_cols TEXT[] := ARRAY[
    'language',
    'timezone_offset_minutes',
    'screen_size',
    'is_bot',
    'utm_source',
    'utm_medium',
    'utm_campaign',
    'latitude',
    'longitude',
    'postal_code',
    'client_id',
    'client_match_score'
  ];
  col TEXT;
BEGIN
  FOREACH col IN ARRAY expected_cols LOOP
    IF NOT EXISTS (
      SELECT 1 FROM information_schema.columns
       WHERE table_name = 'instinct_qr_scans'
         AND column_name = col
    ) THEN
      RAISE EXCEPTION '112_qr_scans_extended: column instinct_qr_scans.% missing — aborting.', col;
    END IF;
  END LOOP;

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'idx_qr_scans_visitor'
      AND n.nspname = current_schema()
  ) THEN
    RAISE EXCEPTION '112_qr_scans_extended: idx_qr_scans_visitor missing — aborting.';
  END IF;

  RAISE NOTICE '112_qr_scans_extended: 12 columns + 1 index added (idempotent).';
END $$;

COMMIT;

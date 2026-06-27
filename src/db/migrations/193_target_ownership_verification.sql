-- 193_target_ownership_verification.sql
--
-- Target OWNERSHIP VERIFICATION: we must never scan or pentest a target the
-- client has not proven they own/authorize. An operator typo, or a stored
-- target pointed at a third party, must be REFUSED before any probe is issued.
--
-- Industry standard (Google Search Console, ACME / Let's Encrypt, Detectify):
-- the server issues a random challenge token; the client proves control of the
-- target out-of-band by placing the token where only the target's owner could
-- (an HTTP file at a well-known path, or a DNS TXT record). The server then
-- fetches/resolves the token and, on match, marks the target verified.
--
-- This migration adds the verification state as a SEPARATE table paired to
-- instinct_scan_targets by (workspace_id, platform). A paired table (rather
-- than columns on instinct_scan_targets) is used so that:
--   * a verification token can be issued/re-issued before a manifest exists,
--   * re-issuing a token never has to UPDATE the manifest row,
--   * the orchestrator gate reads exactly one small row.
--
-- workspace_id and created_by are TEXT (NOT UUID): user/workspace identifiers
-- in this codebase are opaque string slugs ("demo-cto", "default", "tm_<rand>")
-- - see migrations 040 / 144 / 192 and the user-id / workspace-id schema guard
-- tests. A UUID column here would 500 on every real write.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS guards so
-- re-running on an already-migrated DB is a no-op.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_target_verifications (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        TEXT NOT NULL DEFAULT 'default',
  platform            TEXT NOT NULL,
  -- The server-issued challenge token (cryptographically random hex). The
  -- client places this token out-of-band to prove control of the target.
  verification_token  TEXT NOT NULL,
  -- Which method was last attempted / succeeded: 'http_well_known' | 'dns_txt'.
  verification_method TEXT,
  -- 'pending' until proven, then 'verified'; 'failed' records the last failed
  -- attempt (with the reason in verification_reason) without losing the token.
  verification_status TEXT NOT NULL DEFAULT 'pending',
  -- Human-readable last-failure reason (e.g. 'token_mismatch', 'ssrf_blocked',
  -- 'no_txt_record'). Never contains the token itself.
  verification_reason TEXT,
  verified_at         TIMESTAMPTZ,
  created_by          TEXT NOT NULL DEFAULT 'system',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_target_verifications_identity UNIQUE (workspace_id, platform)
);

-- Defensive ADD COLUMN guards: if a prior partial deploy created the table with
-- fewer columns, bring it up to the full shape. No-op on a fresh CREATE above.
ALTER TABLE instinct_target_verifications ADD COLUMN IF NOT EXISTS verification_token  TEXT;
ALTER TABLE instinct_target_verifications ADD COLUMN IF NOT EXISTS verification_method TEXT;
ALTER TABLE instinct_target_verifications ADD COLUMN IF NOT EXISTS verification_status TEXT NOT NULL DEFAULT 'pending';
ALTER TABLE instinct_target_verifications ADD COLUMN IF NOT EXISTS verification_reason TEXT;
ALTER TABLE instinct_target_verifications ADD COLUMN IF NOT EXISTS verified_at         TIMESTAMPTZ;
ALTER TABLE instinct_target_verifications ADD COLUMN IF NOT EXISTS created_by          TEXT NOT NULL DEFAULT 'system';

CREATE INDEX IF NOT EXISTS idx_target_verifications_ws_platform
  ON instinct_target_verifications (workspace_id, platform);

CREATE INDEX IF NOT EXISTS idx_target_verifications_verified
  ON instinct_target_verifications (workspace_id, platform, verified_at);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_target_verifications'
       AND column_name IN (
         'id','workspace_id','platform','verification_token','verification_method',
         'verification_status','verification_reason','verified_at','created_by',
         'created_at','updated_at')
  ) = 11, 'instinct_target_verifications missing expected columns';

  -- Schema-guard parity: workspace_id and created_by must be TEXT.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_target_verifications' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_target_verifications.workspace_id must be TEXT';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_target_verifications' AND column_name = 'created_by'
  ) = 'text', 'instinct_target_verifications.created_by must be TEXT';
END $$;

COMMIT;

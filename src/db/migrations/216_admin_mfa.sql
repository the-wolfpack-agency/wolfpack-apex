-- 216_admin_mfa.sql
--
-- ADMIN MFA (TOTP, RFC 6238) — OPT-IN, SELF-SERVICE enrollment state.
--
-- One row per user that has begun or completed an authenticator-app
-- enrollment. This migration is NON-ENFORCING: it stores enrollment +
-- verification state only. NOTHING in this PR reads this table from the
-- login flow, middleware, or any auth gate — a user with no row, or an
-- un-confirmed row, is fully unaffected. Enforcement is a later PR behind
-- a flag once adoption is proven. This guarantees zero lockout risk.
--
-- Secret handling:
--   * encrypted_secret — the TOTP shared secret, AES-256-GCM encrypted at
--     rest via src/lib/crypto/secret-storage.ts (encryptSecret). NEVER the
--     plaintext base32 secret. Plaintext-at-rest is rejected: a DB read (or
--     a leaked backup) would otherwise hand an attacker the ability to mint
--     valid codes forever.
--   * recovery_code_hashes — one-way SHA-256 hashes of the single-use
--     recovery codes. The plaintext codes are shown to the user exactly
--     once at confirm time and never persisted, so a DB read cannot recover
--     them.
--
-- id is a deterministic TEXT key "mfa_<...>"; user_id + workspace_id are
-- TEXT (opaque slugs, never UUID), matching the ai-surface / ogiam family.
-- Workspace-scoped, so the repo-wide tenant-isolation guardrail covers it.
-- UNIQUE(user_id) — a user has at most one MFA enrollment row.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. RLS enabled with a
-- permissive (deny-by-default tripwire) policy, mirroring migration 207-214.
-- Paired 216_admin_mfa.down.sql.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_admin_mfa (
  id                   TEXT         PRIMARY KEY,
  user_id              TEXT         NOT NULL,
  workspace_id         TEXT         NOT NULL,
  -- AES-256-GCM v1 token from secret-storage.ts. NEVER plaintext.
  encrypted_secret     TEXT         NOT NULL,
  -- NULL until the user confirms a code; a row with confirmed_at IS NULL is a
  -- pending enrollment that the login flow (later PR) must treat as "no MFA".
  confirmed_at         TIMESTAMPTZ,
  -- One-way SHA-256 hashes of single-use recovery codes. Consumed in place
  -- (a used code's hash is removed from the array).
  recovery_code_hashes TEXT[]       NOT NULL DEFAULT '{}',
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- A user has at most one enrollment. Re-enrolling overwrites in place.
  CONSTRAINT instinct_admin_mfa_user_uniq UNIQUE (user_id),
  -- Secret must look like the v1 token (or the encrypt fallback), never raw.
  CONSTRAINT instinct_admin_mfa_secret_chk
    CHECK (encrypted_secret <> '' AND length(encrypted_secret) >= 8)
);

-- Per-workspace + per-user lookup (status reads key on (workspace_id, user_id)).
CREATE INDEX IF NOT EXISTS idx_admin_mfa_workspace_user
  ON instinct_admin_mfa (workspace_id, user_id);

-- Deny-by-default RLS tripwire + permissive policy, mirroring migration 207-214.
ALTER TABLE instinct_admin_mfa ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_admin_mfa_all ON instinct_admin_mfa;
CREATE POLICY instinct_admin_mfa_all ON instinct_admin_mfa
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_admin_mfa'
       AND column_name IN ('id','user_id','workspace_id','encrypted_secret','confirmed_at','recovery_code_hashes','created_at','updated_at')
  ) = 8, 'instinct_admin_mfa missing expected columns';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_admin_mfa' AND column_name = 'id'
  ) = 'text', 'instinct_admin_mfa.id must be TEXT';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_admin_mfa' AND column_name = 'user_id'
  ) = 'text', 'instinct_admin_mfa.user_id must be TEXT';

  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_admin_mfa' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_admin_mfa.workspace_id must be TEXT';

  IF NOT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'instinct_admin_mfa'
      AND c.relkind = 'r'
      AND n.nspname = current_schema()
      AND c.relrowsecurity = true
  ) THEN
    RAISE EXCEPTION 'RLS not enabled on instinct_admin_mfa - aborting migration 216.';
  END IF;
END $$;

COMMIT;

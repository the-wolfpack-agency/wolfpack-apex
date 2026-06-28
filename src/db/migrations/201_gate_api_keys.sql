-- 201_gate_api_keys.sql
--
-- EXTERNAL API KEYS for the OGIAM gate ("bring your own agent").
--
-- A client mints a scoped key so THEIR external agent can call our gate
-- directly. The key is the agent's bearer credential: it maps to an OGIAM
-- principal (kind "ai_agent", scoped to workspace_id + agent label) and carries
-- an allowlist of capabilities the agent may exercise. Enterprise-grade:
--   - HASHED AT REST: only the sha256 of the plaintext key is stored (key_hash).
--     The plaintext is returned ONCE at mint time and never persisted/logged.
--   - LOOKUP BY PREFIX: key_prefix ("ogk_" + first 6 chars of the random body)
--     lets verifyApiKey find the candidate row(s) cheaply, then constant-time
--     compares the full hash. last4 is display-only ("ogk_…ab12").
--   - REVOCABLE: revoked_at is set on revoke; verify rejects revoked keys.
--
-- workspace_id, agent, created_by are TEXT (NOT UUID): workspace/user identifiers
-- in this codebase are opaque string slugs ("default", "demo-cto", "tm_<rand>")
-- and agent is a free-form label ("acme.qa-bot"). See migrations 144 / 192 / 195
-- and the user-id / workspace-id schema-guard tests. id is TEXT (app-generated).
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS + guarded
-- indexes so re-running on an already-migrated DB is a no-op. Paired
-- 201_gate_api_keys.down.sql. RLS enabled with a permissive policy, mirroring the
-- sibling tables' deny-by-default tripwire (see 196_platform_scan_rls.sql).

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_gate_api_keys (
  -- App-generated opaque id (e.g. "gak_<rand>"). TEXT for schema-guard uniformity.
  id            TEXT PRIMARY KEY,
  -- The tenant the key is scoped to. Every verify/list/revoke is workspace-scoped.
  workspace_id  TEXT NOT NULL,
  -- Free-form label for the external agent, e.g. "acme.qa-bot". Maps to the
  -- OgiamPrincipal.agent of the principal this key authenticates.
  agent         TEXT NOT NULL,
  -- sha256(plaintext key), hex. The plaintext is NEVER stored. Constant-time
  -- compared against the recomputed hash on verify.
  key_hash      TEXT NOT NULL,
  -- "ogk_" + first 6 chars of the random body. Indexed lookup handle so verify
  -- does not table-scan; NOT secret on its own (only ~6 chars of entropy shown).
  key_prefix    TEXT NOT NULL,
  -- Last 4 chars of the plaintext, display-only ("ogk_…ab12").
  last4         TEXT,
  -- Allowlist of capabilities this key may exercise at the gate.
  capabilities  TEXT[] NOT NULL DEFAULT '{}',
  -- The operator (user id) who minted the key. NEVER a token.
  created_by    TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Set on revoke; verify rejects keys with a non-null revoked_at.
  revoked_at    TIMESTAMPTZ,
  -- Best-effort usage timestamp, updated on a successful verify.
  last_used_at  TIMESTAMPTZ
);

-- Defensive ADD COLUMN guards: bring a partially-created table up to full shape.
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS workspace_id TEXT NOT NULL DEFAULT 'default';
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS agent        TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS key_hash     TEXT NOT NULL DEFAULT '';
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS key_prefix   TEXT NOT NULL DEFAULT '';
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS last4        TEXT;
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS capabilities TEXT[] NOT NULL DEFAULT '{}';
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS created_by   TEXT;
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS revoked_at   TIMESTAMPTZ;
ALTER TABLE instinct_gate_api_keys ADD COLUMN IF NOT EXISTS last_used_at TIMESTAMPTZ;

-- Prefix lookup (verifyApiKey finds candidate rows by prefix, then hash-compares).
CREATE INDEX IF NOT EXISTS idx_gate_api_keys_prefix
  ON instinct_gate_api_keys (key_prefix);

-- Workspace scan (listApiKeys / revoke are always workspace-scoped).
CREATE INDEX IF NOT EXISTS idx_gate_api_keys_workspace
  ON instinct_gate_api_keys (workspace_id);

-- RLS tripwire: enable RLS with a permissive policy, mirroring the sibling
-- tables (196_platform_scan_rls.sql). The REAL isolation is the app-side
-- workspace_id predicate on every query; this makes the day a real tenant
-- policy is written a single ALTER, not a "remember to enable RLS" step.
ALTER TABLE instinct_gate_api_keys ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_gate_api_keys_all ON instinct_gate_api_keys;
CREATE POLICY instinct_gate_api_keys_all ON instinct_gate_api_keys
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_gate_api_keys'
       AND column_name IN (
         'id','workspace_id','agent','key_hash','key_prefix','last4',
         'capabilities','created_by','created_at','revoked_at','last_used_at')
  ) = 11, 'instinct_gate_api_keys missing expected columns';

  -- Schema-guard parity: opaque-id columns must be TEXT, never UUID / BIGINT.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_gate_api_keys' AND column_name = 'id'
  ) = 'text', 'instinct_gate_api_keys.id must be TEXT';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_gate_api_keys' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_gate_api_keys.workspace_id must be TEXT';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_gate_api_keys' AND column_name = 'created_by'
  ) = 'text', 'instinct_gate_api_keys.created_by must be TEXT';

  -- The tripwire must actually be armed.
  ASSERT (
    SELECT c.relrowsecurity FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'instinct_gate_api_keys'
       AND n.nspname = current_schema()
  ) = true, 'RLS not enabled on instinct_gate_api_keys';

  RAISE NOTICE '201_gate_api_keys: table + indexes + RLS permissive policy ready.';
END $$;

COMMIT;

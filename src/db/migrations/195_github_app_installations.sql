-- 195_github_app_installations.sql
--
-- PER-CLIENT GITHUB APP INSTALLATIONS.
--
-- Today every GitHub call uses ONE org-scoped PAT (GITHUB_TOKEN_WOLFPACK_AGENCY)
-- that can touch every repo we have access to. For our own curated Sites repos
-- that is fine, but to scan + open remediation PRs against a CLIENT'S repos we
-- must NOT hold a single shared credential whose blast radius is every client.
--
-- The industry-standard answer is a GitHub App: the client installs our App on
-- the specific repos they choose, and we mint a SHORT-LIVED installation token
-- scoped to exactly that installation. This table records, per workspace, which
-- installation belongs to which tenant so resolveGithubToken() can mint the
-- right scoped token at call time. When no row exists (or the App env is not
-- configured) the code falls back to the existing PAT, so our own repos keep
-- working with ZERO behavior change.
--
-- workspace_id, installation_id, account_login, linked_by are TEXT (NOT UUID /
-- NOT BIGINT): workspace/user identifiers in this codebase are opaque string
-- slugs ("demo-cto", "default", "tm_<rand>") - see migrations 040 / 144 / 192 /
-- 193 and the user-id / workspace-id schema-guard tests. installation_id is the
-- GitHub numeric installation id but stored as TEXT so the schema guard stays
-- uniform and a future GitHub id-format change never forces a column migration.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + ADD COLUMN IF NOT EXISTS guards so
-- re-running on an already-migrated DB is a no-op.

BEGIN;

CREATE TABLE IF NOT EXISTS github_app_installations (
  -- One installation per workspace (a tenant connects exactly one GitHub
  -- account / org). Re-linking overwrites the row via ON CONFLICT.
  workspace_id     TEXT PRIMARY KEY DEFAULT 'default',
  -- GitHub's numeric installation id, stored as TEXT (schema-guard uniformity).
  installation_id  TEXT NOT NULL,
  -- The GitHub account login the App is installed under (org or user). Display
  -- only - lets the admin UI show "installed on acme-corp" without a round trip.
  account_login    TEXT,
  linked_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- The operator (user id) who linked the installation. NEVER a token.
  linked_by        TEXT NOT NULL DEFAULT 'system'
);

-- Defensive ADD COLUMN guards: bring a partially-created table up to full shape.
ALTER TABLE github_app_installations ADD COLUMN IF NOT EXISTS installation_id TEXT;
ALTER TABLE github_app_installations ADD COLUMN IF NOT EXISTS account_login   TEXT;
ALTER TABLE github_app_installations ADD COLUMN IF NOT EXISTS linked_at       TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE github_app_installations ADD COLUMN IF NOT EXISTS linked_by       TEXT NOT NULL DEFAULT 'system';

CREATE INDEX IF NOT EXISTS idx_github_app_installations_install
  ON github_app_installations (installation_id);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'github_app_installations'
       AND column_name IN (
         'workspace_id','installation_id','account_login','linked_at','linked_by')
  ) = 5, 'github_app_installations missing expected columns';

  -- Schema-guard parity: opaque-id columns must be TEXT, never UUID / BIGINT.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'github_app_installations' AND column_name = 'workspace_id'
  ) = 'text', 'github_app_installations.workspace_id must be TEXT';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'github_app_installations' AND column_name = 'installation_id'
  ) = 'text', 'github_app_installations.installation_id must be TEXT';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'github_app_installations' AND column_name = 'linked_by'
  ) = 'text', 'github_app_installations.linked_by must be TEXT';
END $$;

COMMIT;

-- Migration 027: Microsoft 365 tenant directory + mailbox OOO cache
--
-- Tier 2 · Stream B — paired with:
--   src/lib/integrations/microsoft-directory.ts
--   src/lib/integrations/microsoft-mailbox.ts
--
-- Graph remains source of truth. We cache directory user detail locally so
-- the UI (UserCard / OrgChart) never pays a Graph round-trip on the hot path
-- and so the learning loop can derive reporting chains + team structure
-- without hitting Graph for every RAG query.
--
-- OOO state is kept PER INTERNAL INSTINCT USER (user_id) — we only read
-- own mailbox settings (MailboxSettings.Read scope targets /me, not
-- cross-tenant). The ms_user_id column mirrors the Graph id so downstream
-- joins are symmetric with directory rows.
--
-- Idempotent + additive only: no DROPs, all CREATEs guarded with IF NOT
-- EXISTS. Safe to re-run.

-- ---------------------------------------------------------------------------
-- Directory users (tenant-wide people cache)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_directory_users (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  ms_user_id                 TEXT        NOT NULL,
  user_principal_name        TEXT,
  display_name               TEXT,
  given_name                 TEXT,
  surname                    TEXT,
  mail                       TEXT,
  job_title                  TEXT,
  department                 TEXT,
  office_location            TEXT,
  business_phones            JSONB       NOT NULL DEFAULT '[]'::jsonb,
  mobile_phone               TEXT,
  manager_ms_id              TEXT,
  account_enabled            BOOLEAN     NOT NULL DEFAULT true,
  on_premises_sync_enabled   BOOLEAN,
  created_at                 TIMESTAMPTZ,
  etag                       TEXT,
  synced_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload                    JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT instinct_directory_users_ms_unique UNIQUE (ms_user_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_directory_users_upn
  ON instinct_directory_users (user_principal_name);

CREATE INDEX IF NOT EXISTS idx_instinct_directory_users_department
  ON instinct_directory_users (department);

CREATE INDEX IF NOT EXISTS idx_instinct_directory_users_manager
  ON instinct_directory_users (manager_ms_id);

-- Searchable full-text index — display_name + job_title + department.
-- Guarded in case the running Postgres lacks GIN (shouldn't happen on
-- anything supported, but we keep parity with migration 024's pattern).
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_directory_users_search_fts
             ON instinct_directory_users
             USING GIN (to_tsvector(''english'',
               coalesce(display_name, '''') || '' '' ||
               coalesce(job_title,    '''') || '' '' ||
               coalesce(department,   '''')))';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[027_directory_mailbox] directory users FTS index skipped: %', SQLERRM;
  END;
END$$;

-- ---------------------------------------------------------------------------
-- Mailbox OOO state (per internal instinct user)
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_mailbox_ooo_state (
  id                         UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                    TEXT        NOT NULL,
  ms_user_id                 TEXT,
  is_enabled                 BOOLEAN     NOT NULL DEFAULT false,
  scope                      TEXT        NOT NULL DEFAULT 'none',  -- known|external|all|none
  start_at                   TIMESTAMPTZ,
  end_at                     TIMESTAMPTZ,
  internal_reply_message     TEXT,
  external_reply_message     TEXT,
  synced_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_mailbox_ooo_state_user_unique UNIQUE (user_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_mailbox_ooo_state_ms_user
  ON instinct_mailbox_ooo_state (ms_user_id);

CREATE INDEX IF NOT EXISTS idx_instinct_mailbox_ooo_state_active
  ON instinct_mailbox_ooo_state (is_enabled, start_at, end_at);

-- ---------------------------------------------------------------------------
-- Delta sync bookkeeping — one row per sync scope (e.g. 'directory_users')
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_ms_sync_state (
  scope        TEXT        PRIMARY KEY,
  delta_token  TEXT,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

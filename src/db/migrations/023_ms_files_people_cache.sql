-- Migration 023: Microsoft 365 Files (OneDrive) + People + Contacts local cache.
--
-- Adds metadata-only caching for OneDrive drive items, a write-through mirror
-- for Outlook contacts, and a short-lived cache for People suggestions. No
-- file bytes are stored — downloads use Graph short-lived URLs directly.
-- No presence cache — presence is real-time only.
--
-- Cross-module correlation: assistant + briefing + learning signals join
-- against these tables without extra Graph round-trips. Files shares feed
-- the collaboration graph; contacts feed relationship-strength scoring
-- together with Stream A's instinct_sent_mail + calendar attendance.
--
-- Idempotent + additive only: no DROPs, all CREATEs guarded with IF NOT
-- EXISTS. Safe to re-run.

-- ---------------------------------------------------------------------------
-- instinct_ms_files_metadata — OneDrive drive items (metadata only, never
-- file bytes). Populated on list/get/upload and on demand. download_url is
-- transient (Graph 1-hour URL), stored only for display.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_ms_files_metadata (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           TEXT        NOT NULL,
  ms_drive_item_id  TEXT        NOT NULL,
  name              TEXT        NOT NULL,
  mime_type         TEXT,
  size_bytes        BIGINT,
  web_url           TEXT,
  download_url      TEXT,
  parent_path       TEXT,
  created_at        TIMESTAMPTZ,
  modified_at       TIMESTAMPTZ,
  etag              TEXT,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_ms_files_user_item_unique UNIQUE (user_id, ms_drive_item_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_files_user_modified
  ON instinct_ms_files_metadata (user_id, modified_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_ms_files_user_synced
  ON instinct_ms_files_metadata (user_id, synced_at DESC);

-- Full-text search on filename. Guarded so builds against older PGs or PGs
-- without default English config still succeed.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_ms_files_name_fts
             ON instinct_ms_files_metadata
             USING GIN (to_tsvector(''english'', name))';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[023_ms_files_people_cache] FTS index skipped: %', SQLERRM;
  END;
END$$;

-- ---------------------------------------------------------------------------
-- instinct_contacts_mirror — write-through mirror of /me/contacts. email
-- and phone arrays as JSONB so we can index the common queries later.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_contacts_mirror (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  ms_contact_id   TEXT        NOT NULL,
  display_name    TEXT,
  email_addresses JSONB       NOT NULL DEFAULT '[]'::jsonb,
  phone_numbers   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  company_name    TEXT,
  job_title       TEXT,
  etag            TEXT,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT instinct_contacts_mirror_user_ms_unique UNIQUE (user_id, ms_contact_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_contacts_user_display
  ON instinct_contacts_mirror (user_id, display_name);

CREATE INDEX IF NOT EXISTS idx_instinct_contacts_user_synced
  ON instinct_contacts_mirror (user_id, synced_at DESC);

DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_contacts_emails_gin
             ON instinct_contacts_mirror USING GIN (email_addresses)';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[023_ms_files_people_cache] contacts email GIN skipped: %', SQLERRM;
  END;
END$$;

-- ---------------------------------------------------------------------------
-- instinct_people_suggestions_cache — 60 second TTL per (user_id, query).
-- We store multiple rows per fetch (one per suggestion). A background cleanup
-- (not required for correctness) can prune old rows.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_people_suggestions_cache (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       TEXT        NOT NULL,
  query_key     TEXT        NOT NULL DEFAULT '',
  person_id     TEXT        NOT NULL,
  display_name  TEXT,
  email         TEXT,
  score         REAL,
  source        TEXT,
  rank          INTEGER     NOT NULL DEFAULT 0,
  cached_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_instinct_people_cache_user_cached
  ON instinct_people_suggestions_cache (user_id, cached_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_people_cache_user_query_cached
  ON instinct_people_suggestions_cache (user_id, query_key, cached_at DESC);

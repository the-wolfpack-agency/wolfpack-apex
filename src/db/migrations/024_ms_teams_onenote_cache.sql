-- Migration 024: Microsoft Teams (personal chat) + OneNote local cache
--
-- Stores per-user Teams chat + message data and OneNote page metadata
-- pulled from MS Graph so dashboard + Assistant RAG reads never hit Graph
-- on the hot path. Graph remains the source of truth; writes to OneNote
-- (createPage) are write-through and new pages are upserted locally.
--
-- Paired with src/lib/integrations/microsoft-teams-chat.ts and
-- src/lib/integrations/microsoft-onenote.ts.
--
-- Idempotent + additive only: no DROPs, all CREATEs guarded.

-- ---------------------------------------------------------------------------
-- Teams chats
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_teams_chats (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT        NOT NULL,
  ms_chat_id       TEXT        NOT NULL,
  chat_type        TEXT        NOT NULL DEFAULT 'oneOnOne',
  topic            TEXT,
  participants     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  last_updated_at  TIMESTAMPTZ,
  etag             TEXT,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_teams_chats_user_ms_unique UNIQUE (user_id, ms_chat_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_teams_chats_user_updated
  ON instinct_teams_chats (user_id, last_updated_at DESC);

-- ---------------------------------------------------------------------------
-- Teams messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_teams_messages (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        TEXT        NOT NULL,
  ms_message_id  TEXT        NOT NULL,
  chat_id        UUID        NOT NULL REFERENCES instinct_teams_chats(id) ON DELETE CASCADE,
  sender         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  body           TEXT        NOT NULL DEFAULT '',
  body_html      TEXT,
  importance     TEXT        NOT NULL DEFAULT 'normal',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ,
  synced_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload        JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT instinct_teams_messages_user_ms_unique UNIQUE (user_id, ms_message_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_teams_messages_chat_created
  ON instinct_teams_messages (chat_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_teams_messages_user_created
  ON instinct_teams_messages (user_id, created_at DESC);

-- Full-text search on message bodies — guarded against PGs without GIN.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_teams_messages_body_fts
             ON instinct_teams_messages
             USING GIN (to_tsvector(''english'', coalesce(body, '''')))';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[024_ms_teams_onenote_cache] Teams messages FTS index skipped: %', SQLERRM;
  END;
END$$;

-- ---------------------------------------------------------------------------
-- OneNote pages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS instinct_onenote_pages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  ms_page_id      TEXT        NOT NULL,
  ms_notebook_id  TEXT,
  ms_section_id   TEXT,
  title           TEXT        NOT NULL DEFAULT '',
  preview         TEXT        NOT NULL DEFAULT '',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  modified_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  content_url     TEXT,
  etag            TEXT,
  synced_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_onenote_pages_user_ms_unique UNIQUE (user_id, ms_page_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_onenote_pages_user_modified
  ON instinct_onenote_pages (user_id, modified_at DESC);

DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_onenote_pages_search_fts
             ON instinct_onenote_pages
             USING GIN (to_tsvector(''english'', coalesce(title, '''') || '' '' || coalesce(preview, '''')))';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[024_ms_teams_onenote_cache] OneNote FTS index skipped: %', SQLERRM;
  END;
END$$;

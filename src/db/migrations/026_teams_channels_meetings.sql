-- Migration 026: Microsoft Teams channels + messages + online meetings.
--
-- Tier 2, Stream E. Stores per-user Teams team/channel metadata + channel
-- messages pulled from MS Graph so dashboard + Assistant RAG reads never
-- hit Graph on the hot path. Also stores standalone online meetings
-- created via /me/onlineMeetings (OnlineMeetings.ReadWrite.All scope) so
-- Tier 1 calendar events can link to a persisted Teams meeting record.
--
-- Paired with:
--   src/lib/integrations/microsoft-channel-messages.ts
--   src/lib/integrations/microsoft-online-meetings.ts
--
-- Idempotent + additive only: no DROPs, all CREATEs guarded.

CREATE TABLE IF NOT EXISTS instinct_teams_teams (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          TEXT        NOT NULL,
  ms_team_id       TEXT        NOT NULL,
  display_name     TEXT        NOT NULL DEFAULT '',
  description      TEXT,
  internal_id      TEXT,
  visibility       TEXT,
  created_at       TIMESTAMPTZ,
  etag             TEXT,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_teams_teams_user_ms_unique UNIQUE (user_id, ms_team_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_teams_teams_user_name
  ON instinct_teams_teams (user_id, display_name);

CREATE TABLE IF NOT EXISTS instinct_teams_channels (
  id               UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id          UUID        NOT NULL REFERENCES instinct_teams_teams(id) ON DELETE CASCADE,
  ms_channel_id    TEXT        NOT NULL,
  display_name     TEXT        NOT NULL DEFAULT '',
  description      TEXT,
  membership_type  TEXT        NOT NULL DEFAULT 'standard',
  created_at       TIMESTAMPTZ,
  synced_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_teams_channels_ms_unique UNIQUE (ms_channel_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_teams_channels_team
  ON instinct_teams_channels (team_id);

CREATE TABLE IF NOT EXISTS instinct_teams_channel_messages (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id        UUID        NOT NULL REFERENCES instinct_teams_channels(id) ON DELETE CASCADE,
  ms_message_id     TEXT        NOT NULL,
  ms_reply_to_id    TEXT,
  sender            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  subject           TEXT,
  body              TEXT        NOT NULL DEFAULT '',
  body_html         TEXT,
  importance        TEXT        NOT NULL DEFAULT 'normal',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ,
  mentions          JSONB       NOT NULL DEFAULT '[]'::jsonb,
  synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  payload           JSONB       NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT instinct_teams_channel_messages_ms_unique UNIQUE (ms_message_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_teams_channel_messages_channel_created
  ON instinct_teams_channel_messages (channel_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_teams_channel_messages_reply_to
  ON instinct_teams_channel_messages (ms_reply_to_id)
  WHERE ms_reply_to_id IS NOT NULL;

-- Full-text search across subject + body, guarded against PGs without GIN.
DO $$
BEGIN
  BEGIN
    EXECUTE 'CREATE INDEX IF NOT EXISTS idx_instinct_teams_channel_messages_fts
             ON instinct_teams_channel_messages
             USING GIN (to_tsvector(''english'', coalesce(subject, '''') || '' '' || coalesce(body, '''')))';
  EXCEPTION WHEN others THEN
    RAISE NOTICE '[026_teams_channels_meetings] channel_messages FTS index skipped: %', SQLERRM;
  END;
END$$;

CREATE TABLE IF NOT EXISTS instinct_online_meetings (
  id                                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id                           TEXT        NOT NULL,
  ms_meeting_id                     TEXT        NOT NULL,
  ms_event_id                       TEXT,
  subject                           TEXT        NOT NULL DEFAULT '',
  start_at                          TIMESTAMPTZ,
  end_at                            TIMESTAMPTZ,
  join_web_url                      TEXT,
  conference_id                     TEXT,
  audio_conferencing_toll_number    TEXT,
  participants                      JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at                        TIMESTAMPTZ NOT NULL DEFAULT now(),
  etag                              TEXT,
  synced_at                         TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_online_meetings_user_ms_unique UNIQUE (user_id, ms_meeting_id)
);

CREATE INDEX IF NOT EXISTS idx_instinct_online_meetings_user_start
  ON instinct_online_meetings (user_id, start_at);

CREATE INDEX IF NOT EXISTS idx_instinct_online_meetings_event
  ON instinct_online_meetings (ms_event_id)
  WHERE ms_event_id IS NOT NULL;

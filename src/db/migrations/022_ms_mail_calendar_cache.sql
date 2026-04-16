-- Migration 022: Microsoft 365 Mail send history + Calendar write cache.
--
-- Stream A of the Tier 1 Microsoft Graph expansion (Mail.Send +
-- Calendars.ReadWrite). These are **write-side** cache tables: every
-- outbound send / event mutation records a row here so we have a local,
-- queryable history without re-querying Graph.
--
-- instinct_sent_mail:
--   Row per successful mail send. Feeds the "what did Instinct send?"
--   timeline and per-recipient reply-rate learning signals.
--   body_preview is redacted to <=512 chars (see microsoft-mail.ts).
--
-- instinct_calendar_events_written:
--   Row per calendar create/update/delete. Action column discriminates
--   which kind of mutation. Not an authoritative calendar cache — that
--   remains Graph. This is the audit/learning feed.
--
-- Idempotent + additive only: no DROPs, all CREATEs guarded.

CREATE TABLE IF NOT EXISTS instinct_sent_mail (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  ms_message_id   TEXT        NOT NULL,
  to_recipients   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  cc_recipients   JSONB       NOT NULL DEFAULT '[]'::jsonb,
  bcc_recipients  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  subject         TEXT,
  body_preview    TEXT,
  in_reply_to     TEXT,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  source          TEXT        NOT NULL DEFAULT 'instinct'
);

CREATE INDEX IF NOT EXISTS idx_instinct_sent_mail_user_sent
  ON instinct_sent_mail (user_id, sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_sent_mail_ms_message_id
  ON instinct_sent_mail (ms_message_id);

CREATE INDEX IF NOT EXISTS idx_instinct_sent_mail_in_reply_to
  ON instinct_sent_mail (in_reply_to)
  WHERE in_reply_to IS NOT NULL;

CREATE TABLE IF NOT EXISTS instinct_calendar_events_written (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         TEXT        NOT NULL,
  ms_event_id     TEXT        NOT NULL,
  action          TEXT        NOT NULL,
  subject         TEXT,
  start_at        TIMESTAMPTZ,
  end_at          TIMESTAMPTZ,
  attendees       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  payload         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  performed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT instinct_calendar_events_written_action_chk
    CHECK (action IN ('created', 'updated', 'deleted'))
);

CREATE INDEX IF NOT EXISTS idx_instinct_calendar_events_written_user_time
  ON instinct_calendar_events_written (user_id, performed_at DESC);

CREATE INDEX IF NOT EXISTS idx_instinct_calendar_events_written_ms_event_id
  ON instinct_calendar_events_written (ms_event_id);

-- Migration 020: In-app notifications + per-user preferences
--
-- Surfaces a push channel for Instinct so staff get notified in-app instead
-- of only via morning digests. The notifications library is the single
-- source of truth — other modules MUST call notify(...) in
-- src/lib/notifications/in-app.ts rather than inserting directly.
--
-- Tables:
--   instinct_notifications              — one row per notification
--   instinct_notification_preferences   — one row per user (upsert)
--
-- Idempotent + additive. No DROPs. Safe to run repeatedly.

CREATE TABLE IF NOT EXISTS instinct_notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL,
  category TEXT NOT NULL,                  -- e.g. "hr.onboarding_stalled", "task.due_soon"
  priority TEXT NOT NULL DEFAULT 'normal', -- low | normal | high | critical
  title TEXT NOT NULL,
  body TEXT,
  action_url TEXT,
  action_label TEXT,
  source TEXT NOT NULL,                    -- module that emitted it: hr, tasks, security, etc.
  source_id TEXT,                          -- id in source system, for dedup
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at TIMESTAMPTZ,
  dismissed_at TIMESTAMPTZ,
  clicked_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_notifs_user_created
  ON instinct_notifications (user_id, created_at DESC);

-- Partial index for the bell's hot path: unread only.
CREATE INDEX IF NOT EXISTS idx_notifs_user_unread
  ON instinct_notifications (user_id, read_at)
  WHERE read_at IS NULL;

-- Source+source_id dedup lookups (only when source_id is set).
CREATE INDEX IF NOT EXISTS idx_notifs_source
  ON instinct_notifications (source, source_id)
  WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS instinct_notification_preferences (
  user_id TEXT PRIMARY KEY,
  in_app BOOLEAN NOT NULL DEFAULT true,
  email_digest TEXT NOT NULL DEFAULT 'daily',  -- off | realtime | daily | weekly
  quiet_hours_start TIME,                       -- e.g. 22:00 (local tz)
  quiet_hours_end TIME,                         -- e.g. 07:00 (local tz)
  timezone TEXT NOT NULL DEFAULT 'America/New_York',
  category_overrides JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

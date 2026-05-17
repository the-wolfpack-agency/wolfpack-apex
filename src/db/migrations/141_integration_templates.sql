-- Migration 141 — integration_templates: canonical registry pairing
-- our internal widgets / forms with the external tool + object they
-- mirror. Foundation for the form-schema-mirroring work and the
-- admin "what does each widget map to" insight surface.
--
-- Why this exists: today the mapping is fragmented across
--   - hand-curated FormSpec in src/lib/assistant/forms/specs.ts
--   - WidgetSpec discriminated union in widgets/types.ts
--   - schema hashes per (vendor, object) in integration_health
--   - prose in docs/explainers/assistant-prompts.md
-- A single table gives the nightly orchestrator + the admin
-- dashboard one place to read "widget X mirrors vendor Y's object Z,
-- last seen schema H, used for use cases U[]."
--
-- The `fallback_field_set` JSON is the schema we'll fall back to
-- when the vendor's describe call fails (rate limit, scope missing).
-- It also serves as the bootstrap schema for first-render before the
-- nightly probe runs.

BEGIN;

CREATE TABLE IF NOT EXISTS integration_templates (
  id                   UUID         NOT NULL DEFAULT gen_random_uuid(),
  /* Stable identifier — references the widget or form kind, e.g.
   * "calendar_widget", "create_crm_record_form", "good_morning_widget". */
  template_id          TEXT         NOT NULL,
  /* Where this template surfaces in the UI. */
  surface              TEXT         NOT NULL,
  /* External tool the template mirrors (microsoft, salesforce, hubspot,
   * quickbooks, github, internal). "internal" means we own the source
   * of truth (e.g. org-facts). */
  vendor               TEXT         NOT NULL,
  /* Object within that vendor (Opportunity, Contact, Task, Event,
   * Message, Issue, ...). NULL for non-object surfaces (e.g. the
   * good-morning panel that aggregates many objects). */
  object_type          TEXT,
  /* Human-readable use cases this template enables. Surfaced on the
   * admin dashboard for non-technical readers. */
  use_cases            JSONB        NOT NULL DEFAULT '[]'::jsonb,
  /* Last schema hash captured by the nightly probe — joins to
   * integration_health.schema_hash for drift detection. */
  last_known_schema_hash TEXT,
  /* Bootstrap field set so the widget can render before the first
   * probe runs (or when probes fail). */
  fallback_field_set   JSONB        NOT NULL DEFAULT '[]'::jsonb,
  /* Free-form notes for the admin view. */
  notes                TEXT,
  is_active            BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  updated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id),
  CONSTRAINT integration_templates_surface_chk
    CHECK (surface IN ('widget', 'form', 'page_facts')),
  CONSTRAINT integration_templates_unique_template
    UNIQUE (template_id)
);

CREATE INDEX IF NOT EXISTS integration_templates_vendor_object_idx
  ON integration_templates (vendor, object_type);

CREATE INDEX IF NOT EXISTS integration_templates_active_idx
  ON integration_templates (is_active) WHERE is_active = TRUE;

/* Seed the templates that already exist in code. Each entry mirrors
 * one of the widgets or forms shipped this week. Use cases capture
 * the user-facing value so non-technical readers know what each
 * template does. */
INSERT INTO integration_templates (template_id, surface, vendor, object_type, use_cases, fallback_field_set, notes) VALUES
  ('calendar_widget', 'widget', 'microsoft', 'event',
   '["See the month at a glance", "Click a day to expand meetings", "Deep-link to Outlook"]'::jsonb,
   '[]'::jsonb,
   'Mini month grid; data from listCalendarEvents.'),
  ('email_thread_widget', 'widget', 'microsoft', 'message',
   '["Triage recent inbox without leaving chat", "One-click open in Outlook"]'::jsonb,
   '[]'::jsonb,
   'Top 10 most-recent emails.'),
  ('task_list_widget', 'widget', 'microsoft', 'task',
   '["See open tasks with overdue flags", "Inline check-off"]'::jsonb,
   '[]'::jsonb,
   'Open tasks from MS To-Do cache.'),
  ('good_morning_widget', 'widget', 'microsoft', NULL,
   '["Daily glance: greeting + schedule + action items + meeting pre-brief"]'::jsonb,
   '[]'::jsonb,
   'Aggregates briefing + upcoming meetings.'),
  ('create_email_form', 'form', 'microsoft', 'message',
   '["Draft + send an email without leaving chat"]'::jsonb,
   '[{"name":"to","required":true},{"name":"subject","required":true},{"name":"body","required":true},{"name":"cc","required":false}]'::jsonb,
   'Required fields validated client + server.'),
  ('create_message_form', 'form', 'microsoft', 'chat_message',
   '["Post a Teams chat message"]'::jsonb,
   '[{"name":"chatId","required":true},{"name":"body","required":true}]'::jsonb,
   NULL),
  ('create_calendar_event_form', 'form', 'microsoft', 'event',
   '["Book a meeting with attendees + agenda"]'::jsonb,
   '[{"name":"title","required":true},{"name":"start","required":true},{"name":"end","required":true},{"name":"attendees","required":false}]'::jsonb,
   NULL),
  ('create_task_form', 'form', 'microsoft', 'task',
   '["Create an MS To-Do task tied to a writable list"]'::jsonb,
   '[{"name":"title","required":true},{"name":"listId","required":true},{"name":"body","required":false},{"name":"dueAt","required":false},{"name":"importance","required":false}]'::jsonb,
   'listId dropdown populated from writable cached lists.'),
  ('create_crm_record_form', 'form', 'salesforce', 'Opportunity',
   '["Log a new deal with stage + close date baked in"]'::jsonb,
   '[{"name":"Name","required":true},{"name":"Amount","required":true},{"name":"StageName","required":true},{"name":"CloseDate","required":true}]'::jsonb,
   'Hand-curated today; describe-driven in #2 follow-up.'),
  ('create_okr_form', 'form', 'internal', NULL,
   '["Set quarterly objective + measurable key result"]'::jsonb,
   '[{"name":"quarter","required":true},{"name":"objective","required":true},{"name":"kr_metric","required":true},{"name":"kr_target","required":true}]'::jsonb,
   'Internal source of truth; no external vendor.'),
  ('create_feature_form', 'form', 'internal', NULL,
   '["Submit a feature request or automation idea"]'::jsonb,
   '[{"name":"title","required":true},{"name":"description","required":true},{"name":"priority","required":false},{"name":"targetProduct","required":false}]'::jsonb,
   NULL)
ON CONFLICT (template_id) DO NOTHING;

COMMIT;

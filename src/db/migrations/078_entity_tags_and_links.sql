-- Migration 078 — Instinct L3: polymorphic entity tags + entity links
--
-- Stream: U2 (builds on U1's migration 077 L1 canonical tables).
--
-- L3 (this migration) sits above L1 (instinct_ms_events, _tasks, _messages,
-- _contacts, _files, _change_log, _sync_cursors — all owned by U1). L3 is
-- intentionally polymorphic: one row in instinct_entity_tags can describe
-- a tag applied to ANY entity in the system (an MS event, a site project,
-- a document, a conversation, …). Same pattern for instinct_entity_links.
--
-- The polymorphic (entity_type, entity_id) pair is deliberately TEXT on
-- both sides. entity_id is TEXT because L1 primary keys vary in type
-- (MS Graph event ids are opaque strings; other entities use UUIDs; both
-- fit in TEXT without a cross-schema FK tangle).
--
-- CRITICAL INVARIANT: feature code MUST NOT write to the L1 instinct_ms_*
-- tables directly — only src/lib/ms-graph/sync/** owns those writes. L3
-- (this layer) gives feature code a SAFE place to attach context without
-- contaminating the canonical sync tables. See the paired guard test at
-- src/__tests__/no-feature-writes-l1.test.ts.
--
-- Dedup: the (entity_type, entity_id, tag_key, tag_value, auto_applied)
-- tuple is unique. Explicit user-applied tags and auto-applied tags with
-- the same key/value coexist as separate rows so the auto-tag rule
-- engine can be re-run idempotently without clobbering human edits.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_entity_tags (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type       TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  tag_key           TEXT NOT NULL,
  tag_value         TEXT NOT NULL,
  auto_applied      BOOLEAN NOT NULL DEFAULT FALSE,
  applied_by_user_id TEXT NULL,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instinct_entity_tags_entity
  ON instinct_entity_tags (entity_type, entity_id);

CREATE INDEX IF NOT EXISTS idx_instinct_entity_tags_key_value
  ON instinct_entity_tags (tag_key, tag_value);

-- Composite uniqueness so applyTag() can upsert-dedup without a race.
-- Separate rows for auto vs. explicit user tags (auto_applied in the key).
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_entity_tags_dedup
  ON instinct_entity_tags (entity_type, entity_id, tag_key, tag_value, auto_applied);

CREATE TABLE IF NOT EXISTS instinct_entity_links (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  from_entity_type   TEXT NOT NULL,
  from_entity_id     TEXT NOT NULL,
  to_entity_type     TEXT NOT NULL,
  to_entity_id       TEXT NOT NULL,
  link_type          TEXT NOT NULL,
  auto_applied       BOOLEAN NOT NULL DEFAULT FALSE,
  applied_by_user_id TEXT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_instinct_entity_links_from
  ON instinct_entity_links (from_entity_type, from_entity_id);

CREATE INDEX IF NOT EXISTS idx_instinct_entity_links_to
  ON instinct_entity_links (to_entity_type, to_entity_id);

CREATE INDEX IF NOT EXISTS idx_instinct_entity_links_type
  ON instinct_entity_links (link_type);

CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_entity_links_dedup
  ON instinct_entity_links (
    from_entity_type, from_entity_id,
    to_entity_type, to_entity_id,
    link_type, auto_applied
  );

COMMIT;

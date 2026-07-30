-- 224_engineering_wiki.sql
--
-- The OGIAM Engineering wiki (/engineering): a Confluence-style, hierarchical set
-- of team-facing pages explaining how the systems are built, the tools + stack,
-- the workflow, compliance, testing, tenets, and what the agents can do. Pages
-- form a tree via `parent_slug`, so the wiki grows over time by adding rows, no
-- code change. Body is Markdown, rendered + sanitized on the client.
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS instinct_engineering_pages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug        TEXT NOT NULL,                       -- stable url key + tree ref
  parent_slug TEXT,                                -- NULL = top-level page
  title       TEXT NOT NULL,
  body        TEXT NOT NULL DEFAULT '',            -- Markdown
  position    INT  NOT NULL DEFAULT 0,             -- order among siblings
  published   BOOLEAN NOT NULL DEFAULT TRUE,
  created_by  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One page per slug; re-seeding / editing upserts on the slug.
CREATE UNIQUE INDEX IF NOT EXISTS idx_eng_pages_slug ON instinct_engineering_pages (slug);
-- Tree lookups + sibling ordering.
CREATE INDEX IF NOT EXISTS idx_eng_pages_parent ON instinct_engineering_pages (parent_slug, position);

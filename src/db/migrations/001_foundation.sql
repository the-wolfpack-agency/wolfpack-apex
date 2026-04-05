-- Migration 001: Wolfpack Apex Foundation
--
-- Core tables for the team intelligence platform:
--   - Team members with role-based access
--   - Analytics events (learning loop)
--   - Knowledge base (questions + answers + ratings)
--   - Team journals (daily context)
--   - Feature requests (with analysis)
--   - Discussions (collaborative threads)
--   - Document generations (from codebase)
--   - Prototype sandbox tracking

-- ============================================================================
-- Extensions
-- ============================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ============================================================================
-- 1. Team members
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_team_members (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  email         TEXT         NOT NULL UNIQUE,
  name          TEXT         NOT NULL,
  role          TEXT         NOT NULL CHECK (role IN ('cto', 'dev', 'sales', 'ops')),
  password_hash TEXT         NOT NULL,
  avatar_url    TEXT,
  is_active     BOOLEAN      DEFAULT true,
  last_login    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_team_email ON apex_team_members (email);
CREATE INDEX IF NOT EXISTS idx_apex_team_role ON apex_team_members (role);

-- ============================================================================
-- 2. Analytics events (learning loop)
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_events (
  id            BIGSERIAL    PRIMARY KEY,
  event_type    TEXT         NOT NULL,
  user_id       TEXT         NOT NULL,
  user_role     TEXT         NOT NULL,
  metadata      JSONB        NOT NULL DEFAULT '{}',
  timestamp     TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_events_type ON apex_events (event_type);
CREATE INDEX IF NOT EXISTS idx_apex_events_user ON apex_events (user_id);
CREATE INDEX IF NOT EXISTS idx_apex_events_ts ON apex_events (timestamp);
CREATE INDEX IF NOT EXISTS idx_apex_events_metadata ON apex_events USING GIN (metadata);

-- ============================================================================
-- 3. Knowledge base — questions, answers, ratings
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_knowledge (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  question      TEXT         NOT NULL,
  answer        TEXT         NOT NULL,
  source        TEXT         NOT NULL CHECK (source IN ('codebase', 'docs', 'ai', 'human', 'cached')),
  asked_by      TEXT         NOT NULL,
  repo          TEXT,
  file_path     TEXT,
  confidence    NUMERIC(5,2) DEFAULT 0,
  rating        INTEGER,                    -- 1-5 stars, NULL = unrated
  view_count    INTEGER      DEFAULT 0,
  tokens_used   INTEGER      DEFAULT 0,     -- 0 = zero-token answer
  tags          TEXT[]       DEFAULT '{}',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_knowledge_asked_by ON apex_knowledge (asked_by);
CREATE INDEX IF NOT EXISTS idx_apex_knowledge_repo ON apex_knowledge (repo);
CREATE INDEX IF NOT EXISTS idx_apex_knowledge_source ON apex_knowledge (source);
CREATE INDEX IF NOT EXISTS idx_apex_knowledge_rating ON apex_knowledge (rating) WHERE rating IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_apex_knowledge_question ON apex_knowledge USING GIN (question gin_trgm_ops);

-- ============================================================================
-- 4. Team journals — daily context per member
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_journals (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT         NOT NULL,
  date          DATE         NOT NULL,
  content       TEXT         NOT NULL DEFAULT '',
  auto_context  JSONB        DEFAULT '{}',   -- calendar, actions, questions asked
  mood          TEXT         CHECK (mood IN ('productive', 'neutral', 'blocked', 'creative')),
  highlights    TEXT[]       DEFAULT '{}',
  blockers      TEXT[]       DEFAULT '{}',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (user_id, date)
);

CREATE INDEX IF NOT EXISTS idx_apex_journals_user ON apex_journals (user_id);
CREATE INDEX IF NOT EXISTS idx_apex_journals_date ON apex_journals (date);

-- ============================================================================
-- 5. Feature requests — with analysis
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_feature_requests (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title         TEXT         NOT NULL,
  description   TEXT         NOT NULL,
  submitted_by  TEXT         NOT NULL,
  status        TEXT         NOT NULL DEFAULT 'submitted' CHECK (status IN ('submitted', 'analyzing', 'approved', 'rejected', 'in_progress', 'completed')),
  priority      TEXT         DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  target_product TEXT,                       -- wolfpack-auto, wolfpack-apex, etc.
  analysis      JSONB        DEFAULT '{}',   -- complexity, cost estimate, viability
  comparisons   JSONB        DEFAULT '[]',   -- similar features in competitors
  votes         INTEGER      DEFAULT 0,
  comments      JSONB        DEFAULT '[]',
  estimated_hours NUMERIC(8,1),
  estimated_cost NUMERIC(10,2),
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_features_status ON apex_feature_requests (status);
CREATE INDEX IF NOT EXISTS idx_apex_features_submitted_by ON apex_feature_requests (submitted_by);
CREATE INDEX IF NOT EXISTS idx_apex_features_product ON apex_feature_requests (target_product);

-- ============================================================================
-- 6. Discussions — collaborative threads
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_discussions (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title         TEXT         NOT NULL,
  category      TEXT         NOT NULL CHECK (category IN ('product', 'client', 'engineering', 'process', 'general')),
  created_by    TEXT         NOT NULL,
  status        TEXT         DEFAULT 'open' CHECK (status IN ('open', 'resolved', 'archived')),
  pinned        BOOLEAN      DEFAULT false,
  tags          TEXT[]       DEFAULT '{}',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_discussions_category ON apex_discussions (category);
CREATE INDEX IF NOT EXISTS idx_apex_discussions_status ON apex_discussions (status);
CREATE INDEX IF NOT EXISTS idx_apex_discussions_created_by ON apex_discussions (created_by);

CREATE TABLE IF NOT EXISTS apex_discussion_replies (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  discussion_id TEXT         NOT NULL REFERENCES apex_discussions(id) ON DELETE CASCADE,
  author_id     TEXT         NOT NULL,
  content       TEXT         NOT NULL,
  attachments   JSONB        DEFAULT '[]',   -- { type: "doc" | "link" | "code", url, title }
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_replies_discussion ON apex_discussion_replies (discussion_id);
CREATE INDEX IF NOT EXISTS idx_apex_replies_author ON apex_discussion_replies (author_id);

-- ============================================================================
-- 7. Generated documents
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_documents (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  title         TEXT         NOT NULL,
  doc_type      TEXT         NOT NULL CHECK (doc_type IN ('api_doc', 'feature_doc', 'client_proposal', 'sow', 'email_draft', 'release_notes', 'process_doc', 'custom')),
  content       TEXT         NOT NULL,
  format        TEXT         DEFAULT 'markdown' CHECK (format IN ('markdown', 'html', 'pdf')),
  generated_from TEXT,                       -- repo, file path, or feature ID
  generated_by  TEXT         NOT NULL,
  revision      INTEGER      DEFAULT 1,
  tokens_used   INTEGER      DEFAULT 0,
  downloads     INTEGER      DEFAULT 0,
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_docs_type ON apex_documents (doc_type);
CREATE INDEX IF NOT EXISTS idx_apex_docs_generated_by ON apex_documents (generated_by);

-- ============================================================================
-- 8. Prototype sandbox
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_prototypes (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT         NOT NULL,
  description   TEXT,
  created_by    TEXT         NOT NULL,
  repo_url      TEXT,
  deploy_url    TEXT,
  status        TEXT         DEFAULT 'creating' CHECK (status IN ('creating', 'deployed', 'shared', 'archived')),
  tech_stack    TEXT[]       DEFAULT '{}',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  archived_at   TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_apex_prototypes_created_by ON apex_prototypes (created_by);
CREATE INDEX IF NOT EXISTS idx_apex_prototypes_status ON apex_prototypes (status);

-- ============================================================================
-- 9. Client context
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_clients (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  name          TEXT         NOT NULL,
  industry      TEXT,
  contact_email TEXT,
  contact_name  TEXT,
  notes         TEXT,
  docs          JSONB        DEFAULT '[]',   -- linked documents
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_clients_name ON apex_clients USING GIN (name gin_trgm_ops);

-- ============================================================================
-- 10. Learning views
-- ============================================================================

-- Popular unanswered questions (gaps in knowledge base)
CREATE OR REPLACE VIEW v_knowledge_gaps AS
SELECT
  question,
  COUNT(*) AS times_asked,
  MAX(created_at) AS last_asked
FROM apex_knowledge
WHERE rating IS NULL OR rating <= 2
GROUP BY question
HAVING COUNT(*) >= 2
ORDER BY times_asked DESC;

-- AI usage efficiency (zero-token vs AI calls)
CREATE OR REPLACE VIEW v_ai_efficiency AS
SELECT
  DATE(timestamp) AS day,
  COUNT(*) FILTER (WHERE event_type = 'system.ai_call_skipped') AS zero_token_answers,
  COUNT(*) FILTER (WHERE event_type = 'system.ai_call_made') AS ai_calls,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE event_type = 'system.ai_call_skipped')
    / NULLIF(COUNT(*) FILTER (WHERE event_type IN ('system.ai_call_skipped', 'system.ai_call_made')), 0),
    1
  ) AS zero_token_pct
FROM apex_events
WHERE event_type IN ('system.ai_call_skipped', 'system.ai_call_made')
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY DATE(timestamp)
ORDER BY day DESC;

-- Team activity summary
CREATE OR REPLACE VIEW v_team_activity AS
SELECT
  user_id,
  user_role,
  COUNT(*) AS total_actions,
  COUNT(DISTINCT DATE(timestamp)) AS active_days,
  COUNT(*) FILTER (WHERE event_type LIKE 'knowledge.%') AS knowledge_actions,
  COUNT(*) FILTER (WHERE event_type LIKE 'journal.%') AS journal_actions,
  COUNT(*) FILTER (WHERE event_type LIKE 'feature.%') AS feature_actions,
  COUNT(*) FILTER (WHERE event_type LIKE 'discussion.%') AS discussion_actions,
  MIN(timestamp) AS first_action,
  MAX(timestamp) AS last_action
FROM apex_events
WHERE timestamp > NOW() - INTERVAL '30 days'
GROUP BY user_id, user_role;

-- Knowledge base quality (for improving retrieval)
CREATE OR REPLACE VIEW v_knowledge_quality AS
SELECT
  source,
  COUNT(*) AS total_entries,
  AVG(rating) AS avg_rating,
  SUM(view_count) AS total_views,
  SUM(tokens_used) AS total_tokens,
  ROUND(AVG(tokens_used), 0) AS avg_tokens_per_answer,
  COUNT(*) FILTER (WHERE tokens_used = 0) AS zero_token_count,
  ROUND(
    100.0 * COUNT(*) FILTER (WHERE tokens_used = 0) / NULLIF(COUNT(*), 0), 1
  ) AS zero_token_pct
FROM apex_knowledge
GROUP BY source;

-- Feature request pipeline
CREATE OR REPLACE VIEW v_feature_pipeline AS
SELECT
  status,
  COUNT(*) AS count,
  AVG(estimated_hours) AS avg_hours,
  AVG(estimated_cost) AS avg_cost,
  SUM(votes) AS total_votes
FROM apex_feature_requests
GROUP BY status;

-- Migration 003: Persistent Assistant Memory
--
-- Replaces the in-memory conversation Map with PostgreSQL-backed
-- conversations, messages, and per-user memory. Enables conversation
-- resumption across deploys and provides analytics views.

-- ============================================================================
-- 1. Conversations (persistent, resumable)
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_conversations (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT         NOT NULL,
  title         TEXT,
  status        TEXT         DEFAULT 'active' CHECK (status IN ('active', 'archived')),
  summary       TEXT,
  message_count INTEGER      DEFAULT 0,
  total_tokens  INTEGER      DEFAULT 0,
  last_message_at TIMESTAMPTZ,
  created_at    TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_conversations_user ON apex_conversations (user_id);
CREATE INDEX IF NOT EXISTS idx_apex_conversations_active ON apex_conversations (user_id, status) WHERE status = 'active';

-- ============================================================================
-- 2. Messages (full history)
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_messages (
  id              TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  conversation_id TEXT         NOT NULL REFERENCES apex_conversations(id) ON DELETE CASCADE,
  role            TEXT         NOT NULL CHECK (role IN ('user', 'assistant')),
  content         TEXT         NOT NULL,
  source          TEXT         CHECK (source IN ('knowledge_cache', 'codebase', 'analytics', 'ai', 'fallback')),
  tokens_used     INTEGER      DEFAULT 0,
  rating          INTEGER,
  metadata        JSONB        DEFAULT '{}',
  created_at      TIMESTAMPTZ  DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_apex_messages_conv ON apex_messages (conversation_id);
CREATE INDEX IF NOT EXISTS idx_apex_messages_created ON apex_messages (created_at);

-- ============================================================================
-- 3. User memory (per-member persistent context)
-- ============================================================================
CREATE TABLE IF NOT EXISTS apex_user_memory (
  id            TEXT         PRIMARY KEY DEFAULT gen_random_uuid()::text,
  user_id       TEXT         NOT NULL,
  memory_type   TEXT         NOT NULL CHECK (memory_type IN ('preference', 'expertise', 'context', 'topic', 'instruction')),
  key           TEXT         NOT NULL,
  value         TEXT         NOT NULL,
  confidence    NUMERIC(5,2) DEFAULT 1.0,
  source        TEXT         DEFAULT 'auto',
  created_at    TIMESTAMPTZ  DEFAULT NOW(),
  updated_at    TIMESTAMPTZ  DEFAULT NOW(),
  UNIQUE (user_id, memory_type, key)
);

CREATE INDEX IF NOT EXISTS idx_apex_user_memory_user ON apex_user_memory (user_id);
CREATE INDEX IF NOT EXISTS idx_apex_user_memory_type ON apex_user_memory (user_id, memory_type);

-- ============================================================================
-- 4. Learning views
-- ============================================================================

-- Conversation analytics
CREATE OR REPLACE VIEW v_conversation_analytics AS
SELECT
  user_id,
  COUNT(*) AS total_conversations,
  SUM(message_count) AS total_messages,
  SUM(total_tokens) AS total_tokens_used,
  AVG(message_count) AS avg_messages_per_conversation,
  COUNT(*) FILTER (WHERE total_tokens = 0) AS zero_token_conversations,
  MAX(last_message_at) AS last_active
FROM apex_conversations
GROUP BY user_id;

-- Response quality by source
CREATE OR REPLACE VIEW v_response_quality AS
SELECT
  source,
  COUNT(*) AS total_responses,
  AVG(rating) FILTER (WHERE rating IS NOT NULL) AS avg_rating,
  COUNT(*) FILTER (WHERE rating >= 4) AS good_responses,
  COUNT(*) FILTER (WHERE rating <= 2) AS poor_responses,
  SUM(tokens_used) AS total_tokens
FROM apex_messages
WHERE role = 'assistant'
GROUP BY source;

-- User expertise detection
CREATE OR REPLACE VIEW v_user_expertise_from_conversations AS
SELECT
  c.user_id,
  m.metadata->>'topic' AS topic,
  COUNT(*) AS question_count,
  AVG(m.rating) FILTER (WHERE m.rating IS NOT NULL) AS avg_satisfaction
FROM apex_messages m
JOIN apex_conversations c ON c.id = m.conversation_id
WHERE m.role = 'user' AND m.metadata->>'topic' IS NOT NULL
GROUP BY c.user_id, m.metadata->>'topic'
HAVING COUNT(*) >= 2;

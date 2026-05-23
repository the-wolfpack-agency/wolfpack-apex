-- 159_messages_source_allow_tool.sql — Add 'tool' (and 'page_facts',
-- 'memory', 'cache') to the allowed source values for instinct_messages.
--
-- Why this is urgent (2026-05-23): every tool dispatch in chat() calls
-- dbSaveMessage(..., 'tool', ...). Migration 008 last touched the
-- apex_messages_source_check constraint and limited source to:
--     ('knowledge_cache','codebase','analytics','meeting_transcripts',
--      'ai','fallback')
--
-- That set is missing 'tool', so every tool-backed assistant message
-- (DMS inventory, calendar, email, meeting prep, Vercel deploys, etc.)
-- fails the CHECK on INSERT. safeQuery swallows the error and returns
-- non-fatal — the POST response still carries the answer + widget to
-- the client, so the user sees the widget briefly. But on the next
-- silent refresh (which loads messages from the DB) the assistant
-- message isn't there → React re-renders without it → widget vanishes.
--
-- This was the actual root cause of the "Vercel widget appears then
-- disappears" bug Nick reported across ~6 manual repros today. All
-- prior client-side fixes (key={msg.id}, race-safe merge, metadata
-- fallback, sidebar hide) were chasing the symptom because we never
-- looked at the persistence layer.
--
-- The constraint name is `apex_messages_source_check` (preserved from
-- the Apex→Instinct rename); the table is `instinct_messages` (post-
-- rename). The rename used views so the constraint name survived.
--
-- Adding 'tool' alongside 'page_facts', 'memory', 'cache' because the
-- code in src/lib/assistant.ts also passes those source values at
-- various code paths (see dbSaveMessage call sites). Keeping the
-- existing six values for backward compat with already-persisted rows.

ALTER TABLE instinct_messages
  DROP CONSTRAINT IF EXISTS apex_messages_source_check;

ALTER TABLE instinct_messages
  ADD CONSTRAINT apex_messages_source_check
  CHECK (source IS NULL OR source IN (
    -- Original 6 from migration 008
    'knowledge_cache',
    'codebase',
    'analytics',
    'meeting_transcripts',
    'ai',
    'fallback',
    -- Added 2026-05-23 — see file header for the full incident write-up
    'tool',
    'page_facts',
    'memory',
    'cache'
  ));

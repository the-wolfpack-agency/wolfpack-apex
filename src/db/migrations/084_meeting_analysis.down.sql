-- 084_meeting_analysis.down.sql — reverse of 084_meeting_analysis.sql.
--
-- Drops the analyses table; relies on FK ON DELETE CASCADE from
-- instinct_meeting_messages already defined in 083 — but we drop the
-- analyses table directly since we own it.

BEGIN;

DROP INDEX IF EXISTS idx_instinct_meeting_analyses_msg_latest;
DROP INDEX IF EXISTS idx_instinct_meeting_analyses_topics_gin;
DROP INDEX IF EXISTS idx_instinct_meeting_analyses_msg;
DROP INDEX IF EXISTS uq_instinct_meeting_analyses_msg_ver;
DROP TABLE IF EXISTS instinct_meeting_analyses;

COMMIT;

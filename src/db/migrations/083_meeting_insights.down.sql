-- 083_meeting_insights.down.sql — reversible teardown of 083.
--
-- Drop order matches the FK graph (children first):
--   _exceptions     → _artifacts (+ optional FK to _feeds)
--   _attachments    → _messages
--   _messages       → _feeds + _artifacts
--   _artifacts      (root)
--   _feeds          (root)
--
-- IF EXISTS everywhere so partial / re-run applies stay safe.
--
-- WARNING: this drops ALL meeting-insights ingest history (raw bytes,
-- messages, attachments, feeds, exceptions). There is no recovery short
-- of a DB restore.

BEGIN;

DROP INDEX IF EXISTS idx_instinct_meeting_exceptions_open;
DROP TABLE IF EXISTS instinct_meeting_exceptions;

DROP INDEX IF EXISTS idx_instinct_meeting_attachments_msg;
DROP TABLE IF EXISTS instinct_meeting_attachments;

DROP INDEX IF EXISTS idx_instinct_meeting_messages_artifact;
DROP INDEX IF EXISTS idx_instinct_meeting_messages_feed_recv;
DROP INDEX IF EXISTS uq_instinct_meeting_messages_feed_msg;
DROP TABLE IF EXISTS instinct_meeting_messages;

DROP INDEX IF EXISTS idx_instinct_meeting_artifacts_recv;
DROP INDEX IF EXISTS uq_instinct_meeting_artifacts_dedup;
DROP TABLE IF EXISTS instinct_meeting_artifacts;

DROP INDEX IF EXISTS idx_instinct_meeting_feeds_enabled;
DROP TABLE IF EXISTS instinct_meeting_feeds;

COMMIT;

-- Migration 168: optional screenshot attached to a feedback submission.
--
-- A bug report is far more actionable with a picture of the broken screen.
-- The assistant feedback compose widget now lets a user attach one
-- screenshot, which the client compresses (see lib/assistant/image-compress)
-- to stay under a small cap before upload.
--
-- Storage choice (considered and rejected the alternatives):
--   * Vercel Blob / S3: the "correct" object store at scale, but it adds a
--     runtime dependency and a new env secret, which the infra rules tell us
--     to avoid without strong justification. Feedback screenshots are
--     low-volume, internal, and already compressed to well under 512 KB.
--   * bytea: works, but base64 TEXT round-trips through the JSON API without
--     an extra encode/decode hop and is simpler to reason about.
--   * inlining the image in instinct_user_feedback: would bloat the hot
--     /admin/feedback list query with payloads it does not need.
-- So: a dedicated one-to-one table, base64 TEXT, fetched lazily only when a
-- reader opens the image. If volume ever grows, migrate this single table to
-- object storage behind the same read endpoint without touching callers.
--
-- One screenshot per feedback row (feedback_id is the PK). ON DELETE CASCADE
-- so the de-duplication cleanup (migration 167) and any future feedback
-- delete also drops the orphaned image. Additive and idempotent.

CREATE TABLE IF NOT EXISTS instinct_feedback_screenshot (
  feedback_id   UUID PRIMARY KEY
                  REFERENCES instinct_user_feedback (id) ON DELETE CASCADE,
  -- Allowed raster types only (validated again in the app layer). SVG is
  -- deliberately excluded because it can carry script.
  content_type  TEXT        NOT NULL,
  -- Raw base64 of the compressed image bytes (no "data:" prefix).
  data_base64   TEXT        NOT NULL,
  -- Decoded byte size, for the analytics + a cheap server-side sanity cap.
  byte_size     INTEGER     NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

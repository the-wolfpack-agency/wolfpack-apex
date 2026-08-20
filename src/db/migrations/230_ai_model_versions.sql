-- Which weights actually answered, and when that changed.
--
-- A model id is not a version. "gpt-4o" has meant several different sets of
-- weights, and "claude-sonnet-4-6" will mean more than one before it is
-- retired. Every gate in this system keys on the id, so all of them are
-- reasoning about a name while the thing behind it moves.
--
-- Providers already tell us: the completion response carries the model that
-- actually served, which is often more specific than what was asked for
-- (request gpt-4o, get gpt-4o-2024-11-20). Nothing was reading it, so a silent
-- weights change was invisible until somebody noticed answers had got worse.
--
-- NOT WORKSPACE SCOPED, on purpose. A model version is a fact about the
-- provider, identical for every tenant, so scoping it per workspace would
-- store the same row N times and let two tenants disagree about what OpenAI
-- shipped.
CREATE TABLE IF NOT EXISTS ai_model_versions (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- What the caller asked for: the registry id the gates reason about.
  model_id      TEXT        NOT NULL,
  -- What answered: the provider's own string, verbatim.
  served_version TEXT       NOT NULL,
  provider      TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- How much traffic this version has taken. A version seen twice and a version
  -- seen ten thousand times are different kinds of evidence when deciding
  -- whether a regression is real.
  call_count    BIGINT      NOT NULL DEFAULT 1
);

-- One row per (model asked for, version that answered). Seeing it again bumps
-- the counter rather than adding a row.
CREATE UNIQUE INDEX IF NOT EXISTS ai_model_versions_id_version
  ON ai_model_versions (model_id, served_version);

-- "What is running now, and what was running before" is the whole query.
CREATE INDEX IF NOT EXISTS ai_model_versions_recent
  ON ai_model_versions (model_id, last_seen_at DESC);

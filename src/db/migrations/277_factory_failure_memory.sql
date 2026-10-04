-- Factory brain, part 3: FAILURE / PATTERN MEMORY (source of truth).
--
-- Every time the gate CONFIRMS a problem on a change (a deep-scan finding, a
-- blocking invariant, a policy deny-hit), that is a mistake the factory should not
-- repeat. This table persists a SAFE, redacted description of each confirmed catch
-- so a later run can retrieve "we have been burned by X in this repo" and avoid
-- re-authoring it (retrieval-augmented authoring, pt3 consumer).
--
-- SECURITY: `summary` is a DESCRIPTION (finding class + title), never raw offending
-- code - the write path redacts it, so this memory can never become a secret store.
-- The Qdrant vector index over it is a derived, rebuildable projection (same as the
-- reuse corpus); Postgres here is the authoritative copy.
--
-- Workspace+repo scoped. One row per distinct failure signature; a recurrence bumps
-- times_seen (a repeated mistake ranks higher). Additive + idempotent.
CREATE TABLE IF NOT EXISTS instinct_factory_failure_memory (
  workspace_id  TEXT        NOT NULL DEFAULT 'default',
  repo          TEXT        NOT NULL,
  -- Dedupe key: hash of (finding_class + summary). A recurring identical failure
  -- updates the same row rather than piling up duplicates.
  signature     TEXT        NOT NULL,
  finding_class TEXT        NOT NULL,
  -- SAFE retrieval text (redacted description). This is what gets embedded.
  summary       TEXT        NOT NULL,
  path          TEXT        NOT NULL DEFAULT '',
  severity      TEXT        NOT NULL DEFAULT 'high',
  times_seen    INTEGER     NOT NULL DEFAULT 1,
  embedded      BOOLEAN     NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, repo, signature)
);

CREATE INDEX IF NOT EXISTS idx_factory_failure_memory_ws_repo
  ON instinct_factory_failure_memory (workspace_id, repo);

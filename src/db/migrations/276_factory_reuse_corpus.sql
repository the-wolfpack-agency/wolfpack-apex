-- Factory brain, part 1: the REUSE CORPUS source of truth.
--
-- Persists the factory's per-repo code-path corpus so the reuse-scout can SEARCH
-- an accumulated memory instead of re-embedding the candidate set on every run.
-- This is the authoritative row; the vector index in Qdrant (collection
-- instinct_factory_reuse) is a DERIVED, rebuildable projection of this table - we
-- can wipe and re-embed Qdrant from these rows at any time, which is the real
-- value of keeping Postgres as the source of truth (not "three copies").
--
-- Workspace-scoped. One row per (workspace, repo, path); the latest commit that
-- refreshed it is recorded so a stale path can be reconciled. Additive + idempotent.
CREATE TABLE IF NOT EXISTS instinct_factory_reuse_corpus (
  workspace_id  TEXT        NOT NULL DEFAULT 'default',
  repo          TEXT        NOT NULL,
  path          TEXT        NOT NULL,
  -- The humanized text that was embedded (path words today; file-content summary
  -- later). Kept so the Qdrant vector can be rebuilt without re-deriving it.
  text          TEXT        NOT NULL,
  commit_sha    TEXT        NOT NULL DEFAULT '',
  -- Whether a live vector is believed present in Qdrant for this row (best-effort
  -- bookkeeping; the authoritative store is this table).
  embedded      BOOLEAN     NOT NULL DEFAULT false,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, repo, path)
);

CREATE INDEX IF NOT EXISTS idx_factory_reuse_corpus_ws_repo
  ON instinct_factory_reuse_corpus (workspace_id, repo);

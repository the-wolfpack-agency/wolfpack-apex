-- Factory brain: CONFIDENCE on every memory - the foundation for learning from
-- real outcomes (reinforce on a merged PR, decay on a rejected one) without ever
-- re-indexing Qdrant: confidence is authoritative HERE in Postgres, and retrieval
-- re-ranks similarity x confidence at read time.
--
-- Default 1.0 = neutral, so adding the column is ZERO behavior change until the
-- reinforcement wiring (a later PR) starts moving it. Additive + idempotent.
ALTER TABLE instinct_factory_reuse_corpus
  ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 1.0;

ALTER TABLE instinct_factory_failure_memory
  ADD COLUMN IF NOT EXISTS confidence REAL NOT NULL DEFAULT 1.0;

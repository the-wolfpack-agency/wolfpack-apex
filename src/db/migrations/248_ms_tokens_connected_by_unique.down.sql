-- Revert 248. Restores the plain index and drops the unique one.
-- Note this re-breaks storeTokens, which is the point of a down migration:
-- it returns the schema to the state that shipped, not to a working one.
CREATE INDEX IF NOT EXISTS idx_instinct_ms_tokens_connected_by
  ON instinct_ms_tokens (connected_by);
DROP INDEX IF EXISTS uq_instinct_ms_tokens_connected_by;

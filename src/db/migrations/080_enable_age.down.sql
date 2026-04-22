-- Down migration for 080_enable_age.sql
--
-- Drops the Instinct AGE graph, guarded by existence checks so repeated
-- runs are safe. The `age` EXTENSION is deliberately NOT dropped — other
-- graphs or future migrations may rely on it, and DROP EXTENSION is
-- disruptive enough to require an explicit operator decision.

BEGIN;

DO $$
DECLARE
  age_installed BOOLEAN;
  graph_exists  BOOLEAN;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM pg_extension WHERE extname = 'age'
  ) INTO age_installed;

  IF NOT age_installed THEN
    RAISE NOTICE 'Apache AGE extension not installed; nothing to drop.';
    RETURN;
  END IF;

  EXECUTE 'LOAD ''age''';
  EXECUTE 'SET search_path = ag_catalog, "$user", public';

  SELECT EXISTS (
    SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'instinct'
  ) INTO graph_exists;

  IF graph_exists THEN
    -- `cascade => true` drops all labels + vertices + edges inside the graph.
    PERFORM ag_catalog.drop_graph('instinct', true);
    RAISE NOTICE 'Dropped AGE graph "instinct".';
  ELSE
    RAISE NOTICE 'AGE graph "instinct" does not exist; no-op.';
  END IF;
END $$;

COMMIT;

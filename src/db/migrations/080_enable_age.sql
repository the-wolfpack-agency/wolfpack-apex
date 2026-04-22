-- Enable Apache AGE (A Graph Extension) for the Instinct RAG graph store.
--
-- AGE adds Cypher query support to Postgres as an extension. Graphs are
-- named containers (like schemas) created via `ag_catalog.create_graph()`.
-- We use a single graph named "instinct" to host the knowledge graph
-- behind the AGE-backed GraphStore adapter (src/lib/rag-providers/age-graph.ts).
--
-- Safety-first design — same defensive/idempotent posture as
-- 044_rename_ms_tokens.sql:
--
--   1. DEFENSIVE CREATE — every step uses IF NOT EXISTS / existence guards
--      so repeated runs (fresh DB, partial-rollback, already-applied) are
--      all safe and abort-free.
--
--   2. EXTENSION-MISSING FALLBACK — if the `age` extension is not
--      installed on the host (dev machines without the contrib binary,
--      managed Postgres that has not whitelisted it yet), we RAISE NOTICE
--      and no-op rather than aborting the deploy. The GraphStore adapter
--      is already wired to `safeQuery`, which returns `{rows:[]}` on any
--      failure, so the app degrades gracefully — vector/keyword paths
--      keep working even without the graph.
--
--   3. EXISTENCE ASSERTION (not row-count) — AGE's `create_graph` is
--      metadata-only; we assert the graph is listed in
--      `ag_catalog.ag_graph` after the CREATE, and RAISE NOTICE if it is
--      not. There is no row-count analogue for a graph rename so the
--      044-style COUNT(*) assertion does not apply.
--
--   4. SEARCH_PATH — AGE requires `ag_catalog` on the search_path for
--      the `cypher()` function to resolve. The adapter sets this per
--      connection; the migration sets it inline so the CREATE-graph call
--      works even on a bare session.
--
-- The paired down migration (080_enable_age.down.sql) drops the graph
-- guarded by the same existence check.

BEGIN;

DO $$
DECLARE
  age_available BOOLEAN;
  graph_exists  BOOLEAN;
BEGIN
  -- Is the AGE extension even installable on this host? Managed PG
  -- (Neon, Supabase) often ships without the contrib binary.
  SELECT EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE name = 'age'
  ) INTO age_available;

  IF NOT age_available THEN
    RAISE NOTICE 'Apache AGE extension is not available on this host; skipping graph creation. '
                 'GraphStore adapter will degrade to empty-result mode via safeQuery.';
    RETURN;
  END IF;

  -- Install the extension if not already installed. IF NOT EXISTS means
  -- repeated migrations are no-ops.
  EXECUTE 'CREATE EXTENSION IF NOT EXISTS age';

  -- AGE's cypher() lives in ag_catalog; the session needs it on the
  -- search_path for create_graph() + later cypher() calls to resolve.
  EXECUTE 'LOAD ''age''';
  EXECUTE 'SET search_path = ag_catalog, "$user", public';

  -- Does the "instinct" graph already exist?
  SELECT EXISTS (
    SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'instinct'
  ) INTO graph_exists;

  IF graph_exists THEN
    RAISE NOTICE 'AGE graph "instinct" already exists; no-op.';
  ELSE
    PERFORM ag_catalog.create_graph('instinct');
    RAISE NOTICE 'Created AGE graph "instinct".';
  END IF;

  -- Existence assertion: after all of the above, the graph MUST be
  -- listed. If it is not, something is catastrophically wrong (permission
  -- denied, extension half-installed, etc.) and we abort the txn.
  SELECT EXISTS (
    SELECT 1 FROM ag_catalog.ag_graph WHERE name = 'instinct'
  ) INTO graph_exists;

  IF NOT graph_exists THEN
    RAISE EXCEPTION 'AGE graph "instinct" was not registered after create_graph(); aborting.';
  END IF;
END $$;

COMMIT;

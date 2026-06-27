-- 197_workspace_offboarding_log.sql
--
-- Client OFFBOARDING audit ledger. When a client offboards we must purge ALL of
-- their platform-scan data across Postgres + Qdrant + Neo4j (findings, scans +
-- coverage, targets, ownership verifications, system profiles, automation
-- recommendations, pentest authorizations, and connector credentials). That
-- purge is destructive and irreversible, so we keep a DEFENSIBLE, queryable
-- record of every purge: who ran it, when, exactly how many rows were deleted
-- per table (counts), and any SECONDARY-STORE RESIDUE left behind because Qdrant
-- or Neo4j was unreachable at purge time (residue is a retention RISK and must
-- never be silently dropped - it is logged here for a follow-up retry).
--
-- This is the contractual / GDPR "right to erasure" evidence: a row here proves
-- the erasure happened and quantifies it. The hash-chained audit log records the
-- ACTION; this table records the per-table COUNTS + RESIDUE in a form the
-- offboarding admin page and any compliance export can read directly.
--
-- Schema guard: workspace_id / requested_by are TEXT (opaque string slugs like
-- "demo-cto", "default", "tm_<rand>") - never UUID. A UUID column here would 500
-- on every real write. See migrations 192 / 193 and the user-id / workspace-id
-- schema guard tests.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index. Paired .down.sql drops
-- the table.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_workspace_offboarding_log (
  id            UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT         NOT NULL,
  requested_by  TEXT         NOT NULL,
  purged_at     TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  -- Per-table delete counts: { "instinct_platform_scan_findings": 12, ... }.
  -- A complete, queryable tally of exactly what Postgres erasure removed.
  counts        JSONB        NOT NULL DEFAULT '{}'::jsonb,
  -- Secondary-store leftovers when Qdrant / Neo4j were unreachable at purge time:
  -- { "qdrant": "unreachable", "neo4j": "unreachable" }. Empty {} means a fully
  -- clean purge across all three stores. A non-empty residue is a retention risk
  -- flagged for retry; it is NEVER dropped silently.
  residue       JSONB        NOT NULL DEFAULT '{}'::jsonb
);

-- Hot lookups: "purges for this workspace, newest first" (admin page history) and
-- "purges with outstanding residue" (the retry queue).
CREATE INDEX IF NOT EXISTS idx_workspace_offboarding_ws_purged
  ON instinct_workspace_offboarding_log (workspace_id, purged_at DESC);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_workspace_offboarding_log'
       AND column_name IN ('id','workspace_id','requested_by','purged_at','counts','residue')
  ) = 6, 'instinct_workspace_offboarding_log missing expected columns';

  -- Schema-guard parity: workspace_id and requested_by must be TEXT.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_workspace_offboarding_log' AND column_name = 'workspace_id'
  ) = 'text', 'instinct_workspace_offboarding_log.workspace_id must be TEXT';
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_workspace_offboarding_log' AND column_name = 'requested_by'
  ) = 'text', 'instinct_workspace_offboarding_log.requested_by must be TEXT';
END $$;

COMMIT;

-- 079_company_goals.sql — Company-wide goals v1 data layer.
--
-- Stream: this stream (company-goals). Sits alongside U1's L1 MS-graph
-- tables (migration 077 — instinct_ms_events, instinct_ms_tasks, …) and
-- U2's L3 polymorphic tag/link layer (migration 078 —
-- instinct_entity_tags + instinct_entity_links). The goals feature READS
-- from L1+L3 via joins on instinct_entity_links; it MUST NEVER mutate
-- instinct_ms_* tables (see 078 header's critical invariant + the paired
-- guard test src/__tests__/no-feature-writes-l1.test.ts).
--
-- Design rationale — ONE shared set of company OKRs per quarter.
-- 8-person team; no cascading individual OKRs, no team-level goals;
-- every teammate contributes visibly against the SAME shared KR rows.
-- Contributions arrive from three sources, unified at read time:
--   1. manual commits (CREATE INSERT on instinct_contributions, source
--      = 'manual') — the Friday-sync "I will do X this week" flow.
--   2. auto-linked MS events (L1 row + an L3 link with
--      link_type = 'contributes_to', from_entity_type = 'ms_event',
--      to_entity_type = 'company_kr'). This path is produced by U2's
--      linkEntities() at the point the link is recorded; the contribution
--      row is then stored with source = 'ms_event' + external_entity_id =
--      the ms_event id, so the Friday-sync query is a single-table scan.
--   3. auto-linked MS tasks — same shape with source = 'ms_task'.
-- See feedback_no_silent_data_loss.md: the UNIFIED stream is served by
-- goals-contributions.ts as a single SELECT on instinct_contributions;
-- the L1+L3 join is done ONCE at link-time by linkMSEntityToKR() which
-- writes the contribution row and calls U2's linkEntities() in the same
-- transactional control flow. Trade-off documented at the top of that
-- file: we trade a write on link (+ a well-known external_entity_id
-- column for dedup) for fast Friday-sync reads that never need a join.
--
-- Naming: instinct_* from the start (no legacy apex_* alias). The
-- `instinct_company_*` prefix keeps the OKR family clustered in
-- \dt listings and makes future ENUM / view layering trivial.
--
-- NO silent data loss:
--   * instinct_contributions has NO ON DELETE CASCADE on user_id (users
--     come and go; their contributions survive as immutable history).
--   * kr_id CASCADES on delete so a deleted KR tidies its contributions;
--     but KR deletes are operationally rare — archival via
--     instinct_company_okrs.status = 'archived' is the norm.
--   * graded_as is additive metadata (NULL = ungraded); grading NEVER
--     modifies the contribution body.
--
-- Indexes support the three hot read paths:
--   * getActiveOKRs()                       → (quarter) filtered by status
--   * getContributionsForKR(kr, since/until)→ (kr_id, committed_at DESC)
--   * getWeeklyCommitments(user, week_of)   → (user_id, committed_for_week)

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    -- gen_random_uuid() is provided by pgcrypto; migration 001 installs
    -- it on fresh DBs. This guard keeps the migration safe to run on
    -- scratch DBs where 001 didn't land (dev containers).
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

-- ============================================================
-- instinct_company_okrs — the Objective (one per quarter row)
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_company_okrs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Quarter tag in the form "YYYY-QN" (e.g. "2026-Q2"). Kept as TEXT
  -- not a DATE because OKR quarters are an organizational concept
  -- decoupled from fiscal/calendar ranges; the string sorts naturally.
  quarter             TEXT NOT NULL,
  objective           TEXT NOT NULL,
  -- Lifecycle: draft → active → archived. Only one quarter is 'active'
  -- at a time in practice, but we don't enforce that — the CEO may
  -- want to draft Q3 while Q2 is still running.
  status              TEXT NOT NULL DEFAULT 'draft',
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- TEXT (not UUID) per migration 040 / user-id-columns-schema.test.ts —
  -- user identifiers in this codebase are stable string slugs (e.g.
  -- "demo-cto"), NOT UUIDs. Widening to TEXT at create time avoids a
  -- repeat of the 040 remediation.
  created_by_user_id  TEXT,
  CONSTRAINT instinct_company_okrs_status_chk
    CHECK (status IN ('draft', 'active', 'archived')),
  CONSTRAINT instinct_company_okrs_quarter_chk
    CHECK (quarter ~ '^[0-9]{4}-Q[1-4]$')
);

-- Hot path: getActiveOKRs() filters by quarter + status = 'active'.
CREATE INDEX IF NOT EXISTS idx_instinct_company_okrs_quarter
  ON instinct_company_okrs (quarter);

CREATE INDEX IF NOT EXISTS idx_instinct_company_okrs_status_quarter
  ON instinct_company_okrs (status, quarter)
  WHERE status = 'active';

-- ============================================================
-- instinct_company_krs — Key Results (many per OKR)
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_company_krs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  okr_id              UUID NOT NULL
    REFERENCES instinct_company_okrs(id) ON DELETE CASCADE,
  -- Human-readable metric label, e.g. "paying dealers", "weekly active
  -- employees", "uptime %". We do NOT tokenize / normalize metric names
  -- — the set is small (≤ ~5 per OKR × 4 quarters/yr) and humans own
  -- the vocabulary.
  metric              TEXT NOT NULL,
  target_value        NUMERIC NOT NULL,
  current_value       NUMERIC NOT NULL DEFAULT 0,
  -- Free-text unit label. Nullable because some KRs are dimensionless
  -- (raw counts). When present, carried into the sparkline axes.
  unit                TEXT,
  -- How often the team expects current_value to move. "quarterly" is
  -- the default because most company KRs are re-evaluated per quarter;
  -- "weekly" / "monthly" / "daily" are allowed so the sparkline module
  -- can decide its bucket size.
  cadence             TEXT NOT NULL DEFAULT 'quarterly',
  display_order       INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT instinct_company_krs_cadence_chk
    CHECK (cadence IN ('daily', 'weekly', 'monthly', 'quarterly'))
);

CREATE INDEX IF NOT EXISTS idx_instinct_company_krs_okr
  ON instinct_company_krs (okr_id, display_order);

-- ============================================================
-- instinct_contributions — unified stream of commits & auto-links
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_contributions (
  id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- TEXT (not UUID) — string slug user ids (demo-cto, employees, …).
  user_id                TEXT NOT NULL,
  kr_id                  UUID NOT NULL
    REFERENCES instinct_company_krs(id) ON DELETE CASCADE,
  -- Where this contribution came from. 'manual' = typed by a user in
  -- the Friday-sync flow. 'ms_event' / 'ms_task' = auto-linked via
  -- linkMSEntityToKR() which inserts this row alongside an L3 link
  -- (instinct_entity_links row with link_type='contributes_to'). The
  -- L3 link is the source of truth for the RELATIONSHIP; the
  -- contribution row is an eager-materialized projection so the
  -- weekly-commitment query is a single-table scan.
  source                 TEXT NOT NULL,
  -- Only set when source != 'manual'. 'ms_event' or 'ms_task' for now;
  -- space left for 'commit' when git integration lands.
  external_entity_type   TEXT,
  -- Free-form id of the linked external entity (MS event id, MS task
  -- id, git commit sha, …). TEXT because MS Graph ids are opaque
  -- strings and commit shas are 40-char hex. No FK — the L1 tables
  -- are owned by U1 and we must NOT couple reads across that boundary
  -- via a hard constraint (see 078 invariant).
  external_entity_id     TEXT,
  description            TEXT NOT NULL,
  -- The Friday-sync anchor: this contribution IS the commit for that
  -- week. Nullable because auto-linked rows (ms_event / ms_task) may
  -- not have a specific week — they're read through by event date.
  committed_for_week     DATE,
  committed_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Grading state machine: NULL → 'hit' | 'miss' | 'close'.
  -- Once set, graded_at is set too. Grading is additive metadata; we
  -- never clear a grade (audit trail stays intact).
  graded_as              TEXT,
  graded_at              TIMESTAMPTZ,
  CONSTRAINT instinct_contributions_source_chk
    CHECK (source IN ('manual', 'ms_event', 'ms_task', 'commit')),
  CONSTRAINT instinct_contributions_external_type_chk
    CHECK (
      external_entity_type IS NULL OR
      external_entity_type IN ('ms_event', 'ms_task', 'commit')
    ),
  CONSTRAINT instinct_contributions_graded_chk
    CHECK (
      (graded_as IS NULL AND graded_at IS NULL) OR
      (graded_as IN ('hit', 'miss', 'close') AND graded_at IS NOT NULL)
    ),
  -- If there's an external entity, we must know BOTH its type and id.
  CONSTRAINT instinct_contributions_external_pair_chk
    CHECK (
      (external_entity_type IS NULL AND external_entity_id IS NULL) OR
      (external_entity_type IS NOT NULL AND external_entity_id IS NOT NULL)
    )
);

-- Per-KR timeline: getContributionsForKR() + the stream widget hit this.
CREATE INDEX IF NOT EXISTS idx_instinct_contributions_kr_committed
  ON instinct_contributions (kr_id, committed_at DESC);

-- Per-user week view: getWeeklyCommitments() hits this.
CREATE INDEX IF NOT EXISTS idx_instinct_contributions_user_week
  ON instinct_contributions (user_id, committed_for_week);

-- Dedup for auto-linked rows. Prevents double-insert if
-- linkMSEntityToKR() fires twice for the same (entity, kr) pair. The
-- partial predicate keeps the index tight for the common manual-only
-- case.
CREATE UNIQUE INDEX IF NOT EXISTS uq_instinct_contributions_external_kr
  ON instinct_contributions (kr_id, external_entity_type, external_entity_id)
  WHERE external_entity_type IS NOT NULL AND external_entity_id IS NOT NULL;

-- ============================================================
-- instinct_north_star_snapshots — one north-star metric, sampled
-- ============================================================
CREATE TABLE IF NOT EXISTS instinct_north_star_snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  value       NUMERIC NOT NULL,
  unit        TEXT,
  -- Short label shown under the big number ("paying dealers",
  -- "monthly recurring revenue"). Carried into the sparkline tooltip.
  label       TEXT NOT NULL,
  captured_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Trend queries bucket by captured_at — index supports both the
-- latest-snapshot fetch and daily/weekly rollup sparklines.
CREATE INDEX IF NOT EXISTS idx_instinct_north_star_snapshots_captured
  ON instinct_north_star_snapshots (label, captured_at DESC);

-- Verify the new tables are created and writable. Fail loudly if an
-- RLS policy or a misconfigured search_path left us with empty
-- relations masquerading as tables.
DO $$
DECLARE
  t TEXT;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'instinct_company_okrs',
    'instinct_company_krs',
    'instinct_contributions',
    'instinct_north_star_snapshots'
  ] LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE c.relname = t AND c.relkind = 'r' AND n.nspname = current_schema()
    ) THEN
      RAISE EXCEPTION '% not created — aborting migration 079.', t;
    END IF;
  END LOOP;
  RAISE NOTICE '079_company_goals: all 4 tables + indexes created.';
END $$;

COMMIT;

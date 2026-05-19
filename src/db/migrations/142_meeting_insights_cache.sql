-- Migration 142 — instinct_meeting_insights cache (org-scoped shared insight cache).
--
-- Backs the `prep_for_meeting` cross-source synthesis tool. The hard
-- contract: ONE LLM call per (workspace_id, meeting_id, source_hash).
-- Any teammate who opens the same upcoming meeting after the first
-- generation sees the SAME pre-brief — served from this cache, never
-- re-synthesized. The source_hash invariant means stale source data
-- (a new email landed, a CRM record updated) yields a fresh hash,
-- which misses the cache, which triggers a single fresh LLM call.
--
-- This mirrors the brain-pack / qa-cache pattern: deterministic key,
-- typed JSON payload, hit counter for the learning loop.
--
-- RLS: today the rest of the instinct_* schema is workspace-scoped
-- at the application layer (every safeQuery passes a workspace_id
-- WHERE clause). We follow the same pattern here instead of CREATE
-- POLICY because the deployment isn't running pg roles per tenant —
-- adding RLS without a matching session.user.workspace_id GUC would
-- be cargo-culted. The lookup helper enforces the workspace filter
-- in every read + write path; the guardrail test in
-- meeting-prep.test.ts asserts a query for workspace A never returns
-- a row for workspace B.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_meeting_insights (
  id                     UUID         PRIMARY KEY DEFAULT gen_random_uuid(),
  /* Workspace this cache row belongs to. Two workspaces never see each
   * other's cached insights — enforced by every read passing this in. */
  workspace_id           TEXT         NOT NULL DEFAULT 'default',
  /* Graph event id the insight is about. */
  meeting_id             TEXT         NOT NULL,
  /* sha256 of stringified versionMarkers — CRM lastModified per
   * attendee, last received email timestamp per attendee, last brain
   * edit timestamp. Two calls with identical hash share the row. */
  source_hash            TEXT         NOT NULL,
  /* The MeetingPrep JSON the synthesizer produced. JSONB so future
   * dashboards can index talking-point text + risk severities. */
  insight_json           JSONB        NOT NULL,
  /* When the synthesis ran (LLM call timestamp). */
  generated_at           TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  /* Who triggered the cache miss that produced this row. NULL for
   * background regenerations triggered by the invalidate endpoint. */
  generated_by_user_id   TEXT,
  /* NULL = active. Set to NOW() when the row is invalidated (e.g.
   * regenerate button). The hot-lookup index excludes invalidated
   * rows so a forced regeneration never returns the old payload. */
  invalidated_at         TIMESTAMPTZ,
  /* Every cache hit increments this so the learning loop can rank
   * which meetings get re-opened the most. */
  hit_count              INTEGER      NOT NULL DEFAULT 0,

  CONSTRAINT instinct_meeting_insights_unique_per_hash
    UNIQUE (workspace_id, meeting_id, source_hash)
);

/* Hot lookup: "active row for this workspace + meeting". The lookup
 * path filters by source_hash in code (one more equality predicate);
 * including it in the index doesn't help because uniqueness already
 * guarantees at-most-one row per hash. */
CREATE INDEX IF NOT EXISTS idx_meeting_insights_lookup
  ON instinct_meeting_insights (workspace_id, meeting_id)
  WHERE invalidated_at IS NULL;

COMMENT ON TABLE  instinct_meeting_insights IS
  'Org-scoped meeting pre-brief cache. Single LLM call per source_hash; every teammate sees the same synthesis.';
COMMENT ON COLUMN instinct_meeting_insights.source_hash IS
  'sha256 over versionMarkers (CRM lastModified, last email ts, last brain edit ts) — see src/lib/insights/meeting-prep-sources.ts';

-- Signals table: every user expand/click on a talking point or source
-- ref feeds back into the learning loop. Mirrors instinct_site_brief_edits
-- (migration 029) — durable, append-only, queryable for prompt-weight
-- tuning on the next synthesis. No in-memory orphans.
CREATE TABLE IF NOT EXISTS instinct_meeting_prep_signals (
  id              BIGSERIAL    PRIMARY KEY,
  workspace_id    TEXT         NOT NULL DEFAULT 'default',
  /* Cache row this signal is about — joins back to insight_json so
   * the talking-point text is recoverable without storing it twice. */
  insight_id      UUID         NOT NULL REFERENCES instinct_meeting_insights(id) ON DELETE CASCADE,
  meeting_id      TEXT         NOT NULL,
  user_id         TEXT         NOT NULL,
  user_role       TEXT         NOT NULL,
  /* "talking_point_expanded" | "source_clicked" | "risk_flag_viewed"
   * | "regenerate_clicked". Open-ended on purpose; the aggregator
   *  buckets at read time. */
  kind            TEXT         NOT NULL,
  /* Stable index of the talking point / risk flag / attendee within
   * the insight JSON (0-based). NULL for top-level signals. */
  item_index      INTEGER,
  /* Type of source ref clicked (when kind=source_clicked):
   * "crm" | "email" | "brain" | "calendar" | "meeting". */
  ref_type        TEXT,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_meeting_prep_signals_workspace_meeting
  ON instinct_meeting_prep_signals (workspace_id, meeting_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_meeting_prep_signals_insight
  ON instinct_meeting_prep_signals (insight_id, created_at DESC);

COMMENT ON TABLE instinct_meeting_prep_signals IS
  'Learning loop: every expand/click on a meeting pre-brief talking point or source ref. Feeds prompt-weight tuning on next synthesis.';

COMMIT;

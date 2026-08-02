-- 228_scan_host_baseline.sql
--
-- What each target normally talks to, so "this is new" means something.
--
-- The anomaly detector's strongest signal is a host that appeared BETWEEN two
-- scans and that nothing declares. Without somewhere to remember the previous
-- scan, it can only ever report "unexplained", which on a site with a permissive
-- CSP is most of the internet. This table is what turns a list into a diff.
--
-- WHY firstSeenAt IS NEVER OVERWRITTEN
--
-- "When did this appear" is the question an incident review actually asks, and
-- it is unanswerable once the value has been stamped over. scan_count advances
-- and last_seen_at moves; first_seen_at is written once and left alone. The
-- store enforces that in the upsert rather than trusting every caller.
--
-- WHY THE BASELINE CANNOT LAUNDER A FINDING
--
-- Being in this table costs a host its NOVELTY, never its finding. A site that
-- was already compromised when we first scanned it keeps producing the
-- unexplained-host finding on every subsequent run; only the "new" flag drops.
-- That is deliberate: the alternative is a detector that quietly blesses
-- whatever was wrong on day one.
--
-- Tenant model: workspace_id TEXT, filtered explicitly in every query (the
-- repo-wide tenant-isolation scan requires the predicate to be visible in the
-- query rather than implied by the caller).
--
-- Idempotent.

CREATE TABLE IF NOT EXISTS instinct_scan_host_baseline (
  workspace_id  TEXT        NOT NULL,
  target_id     TEXT        NOT NULL,
  host          TEXT        NOT NULL,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  scan_count    INTEGER     NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, target_id, host)
);

CREATE INDEX IF NOT EXISTS idx_scan_host_baseline_target
  ON instinct_scan_host_baseline (workspace_id, target_id, last_seen_at DESC);

-- Every scan that produced a report, whether or not it found anything. A run
-- with zero findings is evidence too: it is how "we have been watching this
-- site since March" is answerable, and how a gap in coverage becomes visible
-- instead of looking like a clean stretch.
CREATE TABLE IF NOT EXISTS instinct_scan_anomaly_runs (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT        NOT NULL,
  target_id     TEXT        NOT NULL,
  page_url      TEXT        NOT NULL,
  -- The full report as returned, so a finding can be re-read exactly as it was
  -- shown to the client, even after the detector's rules have changed.
  report        JSONB       NOT NULL,
  third_parties INTEGER     NOT NULL DEFAULT 0,
  unexplained   INTEGER     NOT NULL DEFAULT 0,
  novel         INTEGER     NOT NULL DEFAULT 0,
  -- False when the scan was not trustworthy enough to update the baseline.
  -- Recorded rather than inferred: "we chose not to trust this run" is a fact
  -- worth keeping, and it explains a gap in the history to whoever finds one.
  baseline_updated BOOLEAN  NOT NULL DEFAULT FALSE,
  caveats       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scan_anomaly_runs_target
  ON instinct_scan_anomaly_runs (workspace_id, target_id, created_at DESC);

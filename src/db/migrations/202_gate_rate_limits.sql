-- 202_gate_rate_limits.sql
--
-- Per-API-key fixed-window rate-limit counters for the bring-your-own-agent gate
-- (POST /api/gate/authorize). An EXTERNAL agent authenticates with an API key and
-- asks the OGIAM gate to authorize an action; this table is the throttle that
-- keeps any one key from flooding the gate (and the tamper-evident ledger behind
-- it).
--
-- DESIGN: a DB fixed-window counter. One row per (key_id, window_start). Each
-- request does a single atomic upsert that increments count for the current
-- window; the limiter reads the post-increment count and compares it to the
-- per-window limit. The window_start is the request time floored to the window
-- size (e.g. the start of the current minute), so a "window" is a fixed slice of
-- wall-clock time, not a sliding one.
--
-- WHY DB, NOT IN-MEMORY OR REDIS (decision for v1, full rationale in
-- src/lib/ogiam/gate-rate-limit.ts):
--   - in-memory: rejected. Vercel runs many serverless instances; an in-process
--     Map is per-instance, so the effective limit multiplies by the instance
--     count and resets on every cold start. Useless as a real cap.
--   - DB fixed-window (chosen): deterministic, shared across all instances, no new
--     runtime dependency, and the upsert is a single atomic round-trip. Good
--     enough for v1 traffic and trivially testable with an injected clock.
--   - Redis/Upstash (scale path): when QPS outgrows a per-request Postgres write,
--     move the counter to Redis INCR + EXPIRE behind the SAME checkRateLimit()
--     signature. The interface does not change; only the store does.
--
-- Schema guard: key_id is TEXT (opaque api-key id), matching the platform-scan
-- family's TEXT-id convention (migrations 192 / 193 / 197 / 198) and the user-id /
-- workspace-id schema-guard tests. A UUID column would 500 on every real write.
--
-- RLS: permissive (USING true / WITH CHECK true) deny-by-default tripwire,
-- identical to migration 196's rationale - this codebase enforces tenant
-- isolation with an app-side predicate, not session-var RLS, so a restrictive
-- policy would take the product down. Enabling RLS now means the day a real
-- session-var policy lands it takes effect without a separate "enable RLS" step.
--
-- Idempotent: CREATE TABLE IF NOT EXISTS + guarded index + DROP-then-CREATE
-- policy. Paired 202_gate_rate_limits.down.sql drops the table.

BEGIN;

CREATE TABLE IF NOT EXISTS instinct_gate_rate_limits (
  -- The api-key id (opaque, TEXT). NOT the raw key - never store the secret here.
  key_id       TEXT         NOT NULL,
  -- Start of the fixed window this counter covers (request time floored to the
  -- window size). Together with key_id it is the primary key.
  window_start TIMESTAMPTZ  NOT NULL,
  -- Number of requests seen for this key in this window. Incremented atomically.
  count        INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, window_start)
);

-- Hot path: the upsert + read is by (key_id, window_start), already covered by
-- the primary key. This index supports the GC sweep that prunes expired windows
-- ("delete every row older than N windows") without scanning the whole table.
CREATE INDEX IF NOT EXISTS idx_gate_rate_limits_window
  ON instinct_gate_rate_limits (window_start);

ALTER TABLE instinct_gate_rate_limits ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS instinct_gate_rate_limits_all ON instinct_gate_rate_limits;
CREATE POLICY instinct_gate_rate_limits_all ON instinct_gate_rate_limits
  FOR ALL USING (true) WITH CHECK (true);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_gate_rate_limits'
       AND column_name IN ('key_id', 'window_start', 'count')
  ) = 3, 'instinct_gate_rate_limits missing expected columns';

  -- Schema-guard parity: key_id must be TEXT, never UUID.
  ASSERT (
    SELECT data_type FROM information_schema.columns
     WHERE table_name = 'instinct_gate_rate_limits' AND column_name = 'key_id'
  ) = 'text', 'instinct_gate_rate_limits.key_id must be TEXT';

  -- RLS must be enabled (the deny-by-default tripwire).
  ASSERT (
    SELECT relrowsecurity FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relname = 'instinct_gate_rate_limits'
       AND n.nspname = current_schema()
  ), 'RLS not enabled on instinct_gate_rate_limits';
END $$;

COMMIT;

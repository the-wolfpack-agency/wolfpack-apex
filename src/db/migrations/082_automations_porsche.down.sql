-- 082_automations_porsche.down.sql — reversible teardown of 082.
--
-- Drop order matches the FK graph (children first):
--   _exceptions     → _artifacts
--   _deltas         → _snapshots
--   _snapshots      → _artifacts
--   _overrides      (no FK)
--   _poll_state     (no FK)
--   _artifacts      (root)
--
-- IF EXISTS everywhere so partial / re-run applies stay safe.
--
-- WARNING: this drops ALL porsche-classes ingest history (raw bytes,
-- snapshots, deltas, overrides, exceptions, poll cursors). There is no
-- recovery short of a DB restore. Run only when the automation is fully
-- retired.

BEGIN;

DROP INDEX IF EXISTS idx_instinct_auto_porsche_exceptions_open;
DROP TABLE IF EXISTS instinct_automation_porsche_exceptions;

DROP INDEX IF EXISTS idx_instinct_auto_porsche_deltas_curr;
DROP INDEX IF EXISTS idx_instinct_auto_porsche_deltas_class_time;
DROP TABLE IF EXISTS instinct_automation_porsche_deltas;

DROP INDEX IF EXISTS idx_instinct_auto_porsche_snapshots_class_time;
DROP INDEX IF EXISTS uq_instinct_auto_porsche_snapshots_artifact_class;
DROP TABLE IF EXISTS instinct_automation_porsche_snapshots;

DROP INDEX IF EXISTS idx_instinct_auto_porsche_overrides_kind;
DROP TABLE IF EXISTS instinct_automation_porsche_overrides;

DROP TABLE IF EXISTS instinct_automation_porsche_poll_state;

DROP INDEX IF EXISTS idx_instinct_auto_porsche_artifacts_recv;
DROP INDEX IF EXISTS uq_instinct_auto_porsche_artifacts_dedup;
DROP TABLE IF EXISTS instinct_automation_porsche_artifacts;

COMMIT;

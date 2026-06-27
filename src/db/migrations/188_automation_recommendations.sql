-- 188_automation_recommendations.sql: gate-governed automation PROPOSALS the
-- agent derives from a target's SystemProfile + open findings. One row per
-- (workspace_id, platform, key); the engine upserts so re-running refreshes the
-- content while preserving human triage (status/decided_*), exactly like the
-- findings store. These are proposals only; execution stays behind the gate.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_automation_recommendations (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     TEXT NOT NULL DEFAULT 'default',
  platform         TEXT NOT NULL,
  key              TEXT NOT NULL,
  category         TEXT NOT NULL,
  priority         TEXT NOT NULL,
  title            TEXT NOT NULL,
  rationale        TEXT NOT NULL DEFAULT '',
  suggested_action TEXT NOT NULL DEFAULT '',
  source           TEXT NOT NULL DEFAULT '',
  evidence         JSONB NOT NULL DEFAULT '{}'::jsonb,
  status           TEXT NOT NULL DEFAULT 'proposed',
  decided_by       TEXT,
  decided_at       TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_automation_rec_identity UNIQUE (workspace_id, platform, key),
  CONSTRAINT instinct_automation_rec_status_chk
    CHECK (status IN ('proposed', 'accepted', 'dismissed', 'implemented')),
  CONSTRAINT instinct_automation_rec_priority_chk
    CHECK (priority IN ('critical', 'high', 'medium', 'low'))
);

CREATE INDEX IF NOT EXISTS idx_automation_rec_ws_status
  ON instinct_automation_recommendations (workspace_id, status, created_at DESC);

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_automation_recommendations'
       AND column_name IN ('id','workspace_id','platform','key','category','priority','title','rationale','suggested_action','source','evidence','status','decided_by','decided_at','created_at')
  ) = 15, 'instinct_automation_recommendations missing expected columns';
END $$;

COMMIT;

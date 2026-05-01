-- 117_principles_audit_views.sql — internal audit log of leadership
-- access to per-member principle evidence.
--
-- Per the agreed model: the log is internal-only (never surfaced to
-- the subject user). It exists for security review + future
-- compliance reporting, not as a transparency mechanism.
--
-- Defensive guards (per memory feedback_migration_safety):
--   * BEGIN / COMMIT.
--   * IF NOT EXISTS guards.
--   * Final structural assertion DO block.
--   * Paired .down.sql.

BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pgcrypto') THEN
    CREATE EXTENSION IF NOT EXISTS pgcrypto;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS instinct_principle_evidence_views (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  viewer_user_id  TEXT NOT NULL,
  viewer_role     TEXT NOT NULL,
  subject_user_id TEXT,
  route           TEXT NOT NULL,
  evidence_count  INTEGER NOT NULL DEFAULT 0,
  viewed_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_principle_evidence_views_viewer
  ON instinct_principle_evidence_views (viewer_user_id, viewed_at DESC);

CREATE INDEX IF NOT EXISTS idx_principle_evidence_views_subject
  ON instinct_principle_evidence_views (subject_user_id, viewed_at DESC)
  WHERE subject_user_id IS NOT NULL;

DO $$
BEGIN
  ASSERT (
    SELECT COUNT(*) FROM information_schema.columns
     WHERE table_name = 'instinct_principle_evidence_views'
       AND column_name IN ('id','viewer_user_id','viewer_role','subject_user_id','route','evidence_count','viewed_at')
  ) = 7, 'instinct_principle_evidence_views missing expected columns';
END $$;

COMMIT;

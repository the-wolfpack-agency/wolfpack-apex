-- LMS content model + learner progress. Ported from the wolfpack-lms schema
-- design (course -> modules -> lessons, typed content blocks) and adapted to
-- apex conventions: workspace-scoped, UUID keys, CHECK-constrained status. This
-- is the persisted substrate the /builds/security-plain-language course renders
-- from, so a course is data (authorable, reusable) rather than hardcoded copy.
-- No PII beyond the learner's own user id on their enrollment/progress rows.

-- A course: the top-level unit a learner enrolls in.
CREATE TABLE IF NOT EXISTS lms_courses (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  slug         TEXT        NOT NULL,          -- stable url key, e.g. security-plain-language
  title        TEXT        NOT NULL,
  subtitle     TEXT,
  headline     TEXT,
  status       TEXT        NOT NULL DEFAULT 'published',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT lms_courses_status_chk CHECK (status IN ('draft', 'published', 'archived')),
  CONSTRAINT lms_courses_slug_uniq  UNIQUE (workspace_id, slug)
);

-- The capability ladder / certification tiers for a course (Foundations ->
-- Practitioner -> Ambassador). A tier is a competency a learner is certified
-- against, rendered as the course's progression spine.
CREATE TABLE IF NOT EXISTS lms_tracks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  course_id    UUID        NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
  position     INT         NOT NULL,
  name         TEXT        NOT NULL,          -- tier name
  audience     TEXT        NOT NULL,          -- who it is for
  proves       TEXT        NOT NULL,          -- what a learner can DO once certified
  CONSTRAINT lms_tracks_pos_uniq UNIQUE (course_id, position)
);

-- A module groups lessons within a course (e.g. a product-line deep dive).
CREATE TABLE IF NOT EXISTS lms_modules (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  course_id    UUID        NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
  position     INT         NOT NULL,
  title        TEXT        NOT NULL,
  summary      TEXT,
  CONSTRAINT lms_modules_pos_uniq UNIQUE (course_id, position)
);

-- A lesson: the content unit. Body is a typed block array (the wolfpack-lms
-- content-block design in miniature) so lessons are general, not 4-beat-locked.
CREATE TABLE IF NOT EXISTS lms_lessons (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  module_id    UUID        NOT NULL REFERENCES lms_modules(id) ON DELETE CASCADE,
  position     INT         NOT NULL,
  title        TEXT        NOT NULL,
  subtitle     TEXT,
  blocks       JSONB       NOT NULL DEFAULT '[]'::jsonb,
  CONSTRAINT lms_lessons_pos_uniq UNIQUE (module_id, position)
);

-- One learner's enrollment in a course.
CREATE TABLE IF NOT EXISTS lms_enrollments (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id TEXT        NOT NULL,
  course_id    UUID        NOT NULL REFERENCES lms_courses(id) ON DELETE CASCADE,
  user_id      TEXT        NOT NULL,
  status       TEXT        NOT NULL DEFAULT 'active',
  enrolled_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at TIMESTAMPTZ,
  CONSTRAINT lms_enrollments_status_chk CHECK (status IN ('active', 'completed')),
  CONSTRAINT lms_enrollments_uniq UNIQUE (workspace_id, course_id, user_id)
);

-- Per-lesson progress for one enrollment. "doing nothing is visible": a lesson
-- with no row is simply not started.
CREATE TABLE IF NOT EXISTS lms_lesson_progress (
  id            UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  TEXT        NOT NULL,
  enrollment_id UUID        NOT NULL REFERENCES lms_enrollments(id) ON DELETE CASCADE,
  lesson_id     UUID        NOT NULL REFERENCES lms_lessons(id) ON DELETE CASCADE,
  status        TEXT        NOT NULL DEFAULT 'viewed',
  viewed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  completed_at  TIMESTAMPTZ,
  CONSTRAINT lms_lesson_progress_status_chk CHECK (status IN ('viewed', 'completed')),
  CONSTRAINT lms_lesson_progress_uniq UNIQUE (enrollment_id, lesson_id)
);

CREATE INDEX IF NOT EXISTS idx_lms_modules_course  ON lms_modules (course_id, position);
CREATE INDEX IF NOT EXISTS idx_lms_lessons_module  ON lms_lessons (module_id, position);
CREATE INDEX IF NOT EXISTS idx_lms_tracks_course   ON lms_tracks (course_id, position);
CREATE INDEX IF NOT EXISTS idx_lms_enroll_user     ON lms_enrollments (workspace_id, user_id);
CREATE INDEX IF NOT EXISTS idx_lms_progress_enroll ON lms_lesson_progress (enrollment_id);

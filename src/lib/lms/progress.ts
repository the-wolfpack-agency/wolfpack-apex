/**
 * LMS learner progress: enrollment + per-lesson completion, with analytics.
 *
 * Progress is persisted so a learner's place survives a reload and so the
 * course becomes measurable ("which lesson stalls?"), not a static page. Every
 * write emits a course.* event into the learning loop. Best-effort with no DB
 * (returns empty) so a storage hiccup never breaks the course view. A lesson
 * with no row is simply "not started" - doing nothing is visible.
 */
import { query, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

export type LessonStatus = "viewed" | "completed";

export interface CourseProgress {
  enrolled: boolean;
  /** lessonId -> its status. */
  lessons: Record<string, LessonStatus>;
  completed: boolean;
}

interface Actor { userId: string; role: string }

/** Ensure the learner has an enrollment; returns its id (null without a DB). */
export async function ensureEnrollment(
  workspaceId: string,
  courseId: string,
  actor: Actor,
): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  const { rows } = await safeQuery<{ id: string; created: boolean }>(
    `INSERT INTO lms_enrollments (workspace_id, course_id, user_id)
       VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id, course_id, user_id) DO NOTHING
     RETURNING id, true AS created`,
    [workspaceId, courseId, actor.userId],
  );
  if (rows[0]?.created) {
    trackEvent("course.enrolled", actor.userId, actor.role, { course_id: courseId });
    return rows[0].id;
  }
  const { rows: existing } = await safeQuery<{ id: string }>(
    `SELECT id FROM lms_enrollments WHERE workspace_id = $1 AND course_id = $2 AND user_id = $3 LIMIT 1`,
    [workspaceId, courseId, actor.userId],
  );
  return existing[0]?.id ?? null;
}

/** Read the learner's progress for a course (enrollment + lesson statuses). */
export async function getCourseProgress(
  workspaceId: string,
  courseId: string,
  userId: string,
): Promise<CourseProgress> {
  const empty: CourseProgress = { enrolled: false, lessons: {}, completed: false };
  if (!process.env.DATABASE_URL) return empty;
  const { rows: enr } = await safeQuery<{ id: string; status: string }>(
    `SELECT id, status FROM lms_enrollments WHERE workspace_id = $1 AND course_id = $2 AND user_id = $3 LIMIT 1`,
    [workspaceId, courseId, userId],
  );
  const enrollment = enr[0];
  if (!enrollment) return empty;
  const { rows } = await safeQuery<{ lesson_id: string; status: LessonStatus }>(
    `SELECT lesson_id, status FROM lms_lesson_progress WHERE enrollment_id = $1 AND workspace_id = $2`,
    [enrollment.id, workspaceId],
  );
  const lessons: Record<string, LessonStatus> = {};
  for (const r of rows) lessons[r.lesson_id] = r.status;
  return { enrolled: true, lessons, completed: enrollment.status === "completed" };
}

/**
 * Record a lesson as viewed or completed for a learner, auto-enrolling on
 * first touch. When every lesson in the course is completed, the enrollment is
 * marked completed and course.completed fires once. Returns the fresh progress.
 * `allLessonIds` is the course's full lesson id set, so completion is computed
 * against real content, never assumed.
 */
export async function setLessonProgress(input: {
  workspaceId: string;
  courseId: string;
  lessonId: string;
  status: LessonStatus;
  allLessonIds: readonly string[];
  actor: Actor;
}): Promise<CourseProgress> {
  const { workspaceId, courseId, lessonId, status, allLessonIds, actor } = input;
  if (!process.env.DATABASE_URL) return { enrolled: false, lessons: {}, completed: false };

  const enrollmentId = await ensureEnrollment(workspaceId, courseId, actor);
  if (!enrollmentId) return { enrolled: false, lessons: {}, completed: false };

  // Upsert; never downgrade completed -> viewed.
  await query(
    `INSERT INTO lms_lesson_progress (workspace_id, enrollment_id, lesson_id, status, completed_at)
       VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (enrollment_id, lesson_id) DO UPDATE
       SET status = CASE WHEN lms_lesson_progress.status = 'completed' THEN 'completed' ELSE EXCLUDED.status END,
           completed_at = COALESCE(lms_lesson_progress.completed_at, EXCLUDED.completed_at)`,
    [workspaceId, enrollmentId, lessonId, status, status === "completed" ? new Date().toISOString() : null],
  );
  trackEvent(status === "completed" ? "course.lesson_completed" : "course.lesson_viewed", actor.userId, actor.role, {
    course_id: courseId,
    lesson_id: lessonId,
  });

  const progress = await getCourseProgress(workspaceId, courseId, actor.userId);

  // Mark the whole course complete when every lesson is completed.
  const allDone =
    allLessonIds.length > 0 && allLessonIds.every((id) => progress.lessons[id] === "completed");
  if (allDone && !progress.completed) {
    await query(
      `UPDATE lms_enrollments SET status = 'completed', completed_at = now()
        WHERE workspace_id = $1 AND course_id = $2 AND user_id = $3 AND status <> 'completed'`,
      [workspaceId, courseId, actor.userId],
    );
    trackEvent("course.completed", actor.userId, actor.role, { course_id: courseId });
    progress.completed = true;
  }
  return progress;
}

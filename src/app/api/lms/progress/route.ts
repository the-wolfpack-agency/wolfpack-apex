/**
 * POST /api/lms/progress
 *
 * Record a learner action on a lesson: view, complete, or self-check. Auto-
 * enrolls on first touch and, when every lesson is complete, marks the course
 * complete. Learner-level auth. The lesson must belong to the named course, so
 * a client cannot post progress for an arbitrary id.
 *
 *   200 { progress }
 *   400 invalid body / lesson not in course
 *   401 unauthenticated
 *   404 unknown course
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getCourseBySlug } from "@/lib/lms/content";
import { setLessonProgress, getCourseProgress } from "@/lib/lms/progress";
import { trackEvent } from "@/lib/analytics";

type Action = "view" | "complete" | "self_check";
const ACTIONS: readonly Action[] = ["view", "complete", "self_check"];

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "course.view");
  if (!auth.ok) return auth.response;

  let body: { slug?: unknown; lessonId?: unknown; action?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const slug = typeof body.slug === "string" ? body.slug : "";
  const lessonId = typeof body.lessonId === "string" ? body.lessonId : "";
  const action = body.action;
  if (!slug || !lessonId || typeof action !== "string" || !ACTIONS.includes(action as Action)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const course = await getCourseBySlug(auth.user.workspaceId, slug);
  if (!course) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (!course.lessonIds.includes(lessonId)) {
    return NextResponse.json({ error: "lesson_not_in_course" }, { status: 400 });
  }

  const actor = { userId: auth.user.id, role: auth.user.role };

  if (action === "self_check") {
    trackEvent("course.self_checked", actor.userId, actor.role, { course_id: course.id, lesson_id: lessonId });
    const progress = await getCourseProgress(auth.user.workspaceId, course.id, auth.user.id);
    return NextResponse.json({ progress });
  }

  const progress = await setLessonProgress({
    workspaceId: auth.user.workspaceId,
    courseId: course.id,
    lessonId,
    status: action === "complete" ? "completed" : "viewed",
    allLessonIds: course.lessonIds,
    actor,
  });
  return NextResponse.json({ progress });
}

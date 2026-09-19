/**
 * GET /api/lms/courses/[slug]
 *
 * Return an assembled course plus the caller's own progress. Learner-level auth
 * (any signed-in user); no capability gate. The security course is seeded on
 * first read so the page works the moment it deploys.
 *
 *   200 { course, progress }
 *   401 unauthenticated
 *   404 unknown course
 */
import { NextRequest, NextResponse } from "next/server";
import { requireSession } from "@/lib/auth/require-capability";
import { getCourseBySlug } from "@/lib/lms/content";
import { getCourseProgress } from "@/lib/lms/progress";
import { seedSecurityCourse, SECURITY_COURSE_SLUG } from "@/lib/lms/seed-security-course";

export async function GET(req: NextRequest, ctx: { params: Promise<{ slug: string }> }) {
  const auth = await requireSession(req);
  if (!auth.ok) return auth.response;
  const { slug } = await ctx.params;

  if (slug === SECURITY_COURSE_SLUG) {
    await seedSecurityCourse(auth.user.workspaceId);
  }

  const course = await getCourseBySlug(auth.user.workspaceId, slug);
  if (!course) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const progress = await getCourseProgress(auth.user.workspaceId, course.id, auth.user.id);
  return NextResponse.json({ course, progress });
}

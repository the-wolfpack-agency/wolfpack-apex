/**
 * LMS content model + reader. A course is a persisted tree
 * (course -> tracks + modules -> lessons), assembled from the lms_* tables and
 * workspace-scoped. Lesson bodies are typed block arrays (the wolfpack-lms
 * content-block design in miniature) so a lesson is general, not locked to one
 * course's shape. Reads fail open (null / empty) so the course page degrades to
 * an empty state rather than throwing.
 */
import { safeQuery } from "@/lib/db";

/** A typed lesson content block. The security course uses the four
 *  plain-language beats; the model stays general for other courses. */
export type LessonBlock =
  | { type: "glossary"; term: string }
  | { type: "plain"; text: string }
  | { type: "stops"; text: string }
  | { type: "without"; text: string }
  | { type: "heading"; text: string }
  | { type: "text"; text: string };

export interface LmsTrack {
  id: string;
  position: number;
  name: string;
  audience: string;
  proves: string;
}

export interface LmsLesson {
  id: string;
  position: number;
  title: string;
  subtitle: string | null;
  blocks: LessonBlock[];
}

export interface LmsModule {
  id: string;
  position: number;
  title: string;
  summary: string | null;
  lessons: LmsLesson[];
}

export interface LmsCourse {
  id: string;
  slug: string;
  title: string;
  subtitle: string | null;
  headline: string | null;
  tracks: LmsTrack[];
  modules: LmsModule[];
  /** Flat lesson id list in render order - the progression spine. */
  lessonIds: string[];
}

interface CourseRow { id: string; slug: string; title: string; subtitle: string | null; headline: string | null }
interface TrackRow { id: string; position: number; name: string; audience: string; proves: string }
interface ModuleRow { id: string; position: number; title: string; summary: string | null }
interface LessonRow { id: string; module_id: string; position: number; title: string; subtitle: string | null; blocks: LessonBlock[] }

/** Assemble one published course by slug for a workspace, or null if absent. */
export async function getCourseBySlug(workspaceId: string, slug: string): Promise<LmsCourse | null> {
  const { rows: courseRows } = await safeQuery<CourseRow>(
    `SELECT id, slug, title, subtitle, headline
       FROM lms_courses
      WHERE workspace_id = $1 AND slug = $2 AND status = 'published'
      LIMIT 1`,
    [workspaceId, slug],
  );
  const course = courseRows[0];
  if (!course) return null;

  const [{ rows: trackRows }, { rows: moduleRows }, { rows: lessonRows }] = await Promise.all([
    safeQuery<TrackRow>(
      `SELECT id, position, name, audience, proves FROM lms_tracks WHERE course_id = $1 AND workspace_id = $2 ORDER BY position`,
      [course.id, workspaceId],
    ),
    safeQuery<ModuleRow>(
      `SELECT id, position, title, summary FROM lms_modules WHERE course_id = $1 AND workspace_id = $2 ORDER BY position`,
      [course.id, workspaceId],
    ),
    safeQuery<LessonRow>(
      `SELECT l.id, l.module_id, l.position, l.title, l.subtitle, l.blocks
         FROM lms_lessons l
         JOIN lms_modules m ON m.id = l.module_id
        WHERE m.course_id = $1 AND l.workspace_id = $2
        ORDER BY m.position, l.position`,
      [course.id, workspaceId],
    ),
  ]);

  const lessonsByModule = new Map<string, LmsLesson[]>();
  for (const r of lessonRows) {
    const arr = lessonsByModule.get(r.module_id) ?? [];
    arr.push({ id: r.id, position: r.position, title: r.title, subtitle: r.subtitle, blocks: Array.isArray(r.blocks) ? r.blocks : [] });
    lessonsByModule.set(r.module_id, arr);
  }

  const modules: LmsModule[] = moduleRows.map((m) => ({
    id: m.id, position: m.position, title: m.title, summary: m.summary,
    lessons: lessonsByModule.get(m.id) ?? [],
  }));

  return {
    id: course.id,
    slug: course.slug,
    title: course.title,
    subtitle: course.subtitle,
    headline: course.headline,
    tracks: trackRows.map((t) => ({ id: t.id, position: t.position, name: t.name, audience: t.audience, proves: t.proves })),
    modules,
    lessonIds: modules.flatMap((m) => m.lessons.map((l) => l.id)),
  };
}

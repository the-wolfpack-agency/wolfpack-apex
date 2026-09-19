/**
 * Seed the "Security in Plain Language" course from its single source of truth,
 * src/lib/builds/security-plain-language.ts. The build module stays the SoT for
 * the content (a test pins its shape); this projects those typed constants into
 * the lms_* tables so the course renders from persisted, general LMS data.
 *
 * SEED-ONCE. If the course already has modules it returns untouched, so
 * reseeding never deletes lessons (and thus never orphans learner progress,
 * which references lesson ids). Content revisions are a later, versioned concern.
 */
import { query, safeQuery, hasDatabase } from "@/lib/db";
import {
  HEADLINE, CERT_PREMISE, PRECISION_NOTE, CERT_TIERS, PRODUCTS, DEEP_DIVES, ACQUISITIONS,
  type ProductPlain, type AcquisitionPlain,
} from "@/lib/builds/security-plain-language";
import type { LessonBlock } from "./content";

export const SECURITY_COURSE_SLUG = "security-plain-language";

function productBlocks(p: ProductPlain): LessonBlock[] {
  return [
    { type: "glossary", term: p.jargon },
    { type: "plain", text: p.plain },
    { type: "stops", text: p.stops },
    { type: "without", text: p.without },
  ];
}
function acquisitionBlocks(a: AcquisitionPlain): LessonBlock[] {
  return [
    { type: "text", text: a.brought },
    { type: "plain", text: a.plain },
    { type: "stops", text: a.stops },
    { type: "without", text: a.without },
  ];
}

interface ModuleSpec { title: string; summary: string; lessons: { title: string; subtitle: string; blocks: LessonBlock[] }[] }

/** The course structure derived from the SoT. Pure - unit-testable without a DB. */
export function buildSecurityCourseSpec() {
  const modules: ModuleSpec[] = [
    {
      title: "The product line, in plain words",
      summary: PRECISION_NOTE,
      lessons: PRODUCTS.map((p) => ({ title: p.name, subtitle: p.jargon, blocks: productBlocks(p) })),
    },
    ...DEEP_DIVES.map((d) => ({
      title: d.product,
      summary: d.what,
      lessons: d.features.map((f) => ({ title: f.name, subtitle: f.jargon, blocks: productBlocks(f) })),
    })),
    {
      title: "Recent acquisitions, in plain words",
      summary: "The acquisitions arrive with their own jargon; the same four beats translate them.",
      lessons: ACQUISITIONS.map((a) => ({ title: a.name, subtitle: a.brought, blocks: acquisitionBlocks(a) })),
    },
  ];
  return {
    slug: SECURITY_COURSE_SLUG,
    title: "Security in Plain Language",
    subtitle: CERT_PREMISE,
    headline: HEADLINE,
    tracks: CERT_TIERS.map((t) => ({ name: t.tier, audience: t.who, proves: t.proves })),
    modules,
  };
}

/** Idempotently ensure the security course exists for a workspace. Returns the
 *  course id (null without a DB). Seed-once: skips if modules already exist. */
export async function seedSecurityCourse(workspaceId: string): Promise<string | null> {
  if (!hasDatabase()) return null;
  const spec = buildSecurityCourseSpec();

  // Upsert the course row, get its id.
  const { rows: up } = await query<{ id: string }>(
    `INSERT INTO lms_courses (workspace_id, slug, title, subtitle, headline, status)
       VALUES ($1, $2, $3, $4, $5, 'published')
     ON CONFLICT (workspace_id, slug) DO UPDATE
       SET title = EXCLUDED.title, subtitle = EXCLUDED.subtitle, headline = EXCLUDED.headline
     RETURNING id`,
    [workspaceId, spec.slug, spec.title, spec.subtitle, spec.headline],
  );
  const courseId = up[0]?.id;
  if (!courseId) return null;

  // Seed-once: if content already present, do not rebuild (protects progress).
  const { rows: existing } = await safeQuery<{ n: string }>(
    `SELECT count(*)::text AS n FROM lms_modules WHERE course_id = $1 AND workspace_id = $2`,
    [courseId, workspaceId],
  );
  if (Number(existing[0]?.n ?? "0") > 0) return courseId;

  for (let i = 0; i < spec.tracks.length; i++) {
    const t = spec.tracks[i];
    await query(
      `INSERT INTO lms_tracks (workspace_id, course_id, position, name, audience, proves)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, courseId, i, t.name, t.audience, t.proves],
    );
  }
  for (let mi = 0; mi < spec.modules.length; mi++) {
    const m = spec.modules[mi];
    const { rows: mr } = await query<{ id: string }>(
      `INSERT INTO lms_modules (workspace_id, course_id, position, title, summary)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [workspaceId, courseId, mi, m.title, m.summary],
    );
    const moduleId = mr[0].id;
    for (let li = 0; li < m.lessons.length; li++) {
      const l = m.lessons[li];
      await query(
        `INSERT INTO lms_lessons (workspace_id, module_id, position, title, subtitle, blocks)
           VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
        [workspaceId, moduleId, li, l.title, l.subtitle, JSON.stringify(l.blocks)],
      );
    }
  }
  return courseId;
}

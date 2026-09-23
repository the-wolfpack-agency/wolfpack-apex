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
  PRACTITIONER_PLAYS, AMBASSADOR_DRILL,
  type ProductPlain, type AcquisitionPlain, type PractitionerPlay,
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
function practitionerBlocks(p: PractitionerPlay): LessonBlock[] {
  return [
    { type: "plain", text: p.problem },
    { type: "text", text: `Reach for: ${p.product}` },
    { type: "plain", text: p.say },
    { type: "text", text: `When they push back: ${p.objection}` },
    { type: "plain", text: p.answer },
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
    {
      title: "Practitioner: map the problem, handle the objection",
      summary: "Foundations proves you can SAY it. Practitioner proves you can pick the right product for a customer's real problem and hold the line, in plain words, when they push back.",
      lessons: PRACTITIONER_PLAYS.map((p) => ({ title: p.product, subtitle: "objection handling", blocks: practitionerBlocks(p) })),
    },
    {
      title: "Ambassador: keep the fluency current",
      summary: AMBASSADOR_DRILL.intro,
      lessons: AMBASSADOR_DRILL.drills.map((d) => ({ title: d.habit, subtitle: "a habit that keeps the plain language alive", blocks: [{ type: "plain", text: d.how }] as LessonBlock[] })),
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

  // ADDITIVE reconcile (was seed-once). Insert only what is missing - new tracks
  // by name, new modules by title (with their lessons) at the next free position -
  // so existing modules and lessons keep their ids and no learner progress is
  // orphaned. Content revisions to an EXISTING lesson remain a later, versioned
  // concern; this only ever adds, never edits or deletes.
  const { rows: haveTracks } = await safeQuery<{ name: string }>(
    `SELECT name FROM lms_tracks WHERE course_id = $1 AND workspace_id = $2`,
    [courseId, workspaceId],
  );
  const trackNames = new Set(haveTracks.map((r) => r.name));
  const { rows: haveMods } = await safeQuery<{ title: string; position: number }>(
    `SELECT title, position FROM lms_modules WHERE course_id = $1 AND workspace_id = $2`,
    [courseId, workspaceId],
  );
  const moduleTitles = new Set(haveMods.map((r) => r.title));
  let nextTrackPos = haveTracks.length;
  let nextModPos = haveMods.reduce((mx, r) => Math.max(mx, r.position + 1), 0);

  for (const t of spec.tracks) {
    if (trackNames.has(t.name)) continue;
    await query(
      `INSERT INTO lms_tracks (workspace_id, course_id, position, name, audience, proves)
         VALUES ($1, $2, $3, $4, $5, $6)`,
      [workspaceId, courseId, nextTrackPos++, t.name, t.audience, t.proves],
    );
  }
  for (const m of spec.modules) {
    if (moduleTitles.has(m.title)) continue;
    const { rows: mr } = await query<{ id: string }>(
      `INSERT INTO lms_modules (workspace_id, course_id, position, title, summary)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [workspaceId, courseId, nextModPos++, m.title, m.summary],
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

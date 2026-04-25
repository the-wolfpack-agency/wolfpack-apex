/**
 * POST /api/automations/porsche-classes/manual-ingest — operator path
 * for backfilling a survey / coordinator / instructor / xlsx artifact
 * when the email never arrived (parser shipped after the fact, lost
 * email, vendor portal export, etc).
 *
 * Reuses the same `ingestArtifact` pipeline the inbox poller uses, so
 * the artifact lands in the same audit table, the same parser fires,
 * and the same exception queue catches malformed inputs. The only
 * difference is the source_message_id: we mint a synthetic
 * `manual:<userId>:<timestamp>` so dedupe works against re-uploads but
 * doesn't collide with Graph message ids.
 *
 * Auth: `automations.run` capability (same as the "Run now" button —
 * the program owner already has it).
 *
 * Body: multipart/form-data
 *   - file: the xlsx (or eml/html for cognito)
 *   - source_type: one of porsche_xlsx | cognito_coordinator |
 *                  cognito_instructor | survey
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { ingestArtifact } from "@/lib/automations/porsche-classes/ingest";
import type {
  AutomationSourceType,
  CourseType,
} from "@/lib/automations/types";

/**
 * Parse a class_key of the form "BA101|2026-04-20|Ritz Carlton" into
 * the (course_type, class_date, location) triple parser-survey expects
 * as a class_override. Returns null when the shape is malformed —
 * caller treats null as "no override, fall back to filename regex".
 */
function parseClassKey(
  raw: string,
): { course_type: CourseType; class_date: string; location: string } | null {
  const parts = raw.split("|");
  if (parts.length !== 3) return null;
  const [course, date, location] = parts.map((p) => p.trim());
  if (course !== "BA101" && course !== "BA102") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;
  if (!location) return null;
  return { course_type: course, class_date: date, location };
}

const ALLOWED_SOURCE_TYPES = new Set<AutomationSourceType>([
  "porsche_xlsx",
  "cognito_coordinator",
  "cognito_instructor",
  "survey",
]);

const MIME_BY_SOURCE: Record<string, string> = {
  porsche_xlsx:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  survey:
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  cognito_coordinator: "text/html",
  cognito_instructor: "text/html",
};

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  const automation = getAutomation("porsche-classes");
  if (!automation) {
    return NextResponse.json(
      { error: "automation 'porsche-classes' not registered" },
      { status: 500 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch (err) {
    return NextResponse.json(
      { error: `expected multipart/form-data: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  const sourceTypeRaw = form.get("source_type");
  const file = form.get("file");

  if (typeof sourceTypeRaw !== "string") {
    return NextResponse.json(
      { error: "field 'source_type' is required" },
      { status: 400 },
    );
  }
  if (!ALLOWED_SOURCE_TYPES.has(sourceTypeRaw as AutomationSourceType)) {
    return NextResponse.json(
      {
        error: `unsupported source_type '${sourceTypeRaw}' — expected one of ${[
          ...ALLOWED_SOURCE_TYPES,
        ].join(", ")}`,
      },
      { status: 400 },
    );
  }
  if (!(file instanceof File)) {
    return NextResponse.json(
      { error: "field 'file' is required and must be a file upload" },
      { status: 400 },
    );
  }

  const sourceType = sourceTypeRaw as AutomationSourceType;
  const bytes = Buffer.from(await file.arrayBuffer());
  if (bytes.length === 0) {
    return NextResponse.json(
      { error: "uploaded file is empty" },
      { status: 400 },
    );
  }

  /* Optional class_key override — when the operator uploads from a
     specific class's summary page they pass the page's class_key so
     the parser routes the snapshot to THAT class regardless of what
     the filename / form fields say. Validated for shape; ill-formed
     ⇒ 400 because the only callers that send it are our own UI which
     should never produce a malformed value. */
  const classKeyRaw = form.get("class_key");
  let classOverride: ReturnType<typeof parseClassKey> = null;
  if (typeof classKeyRaw === "string" && classKeyRaw.length > 0) {
    classOverride = parseClassKey(classKeyRaw);
    if (!classOverride) {
      return NextResponse.json(
        {
          error:
            `class_key '${classKeyRaw}' must be of the form ` +
            `BA101|YYYY-MM-DD|Location`,
        },
        { status: 400 },
      );
    }
  }

  const result = await ingestArtifact({
    automation,
    source_type: sourceType,
    /* Synthetic id so dedupe on (source_message_id, content_sha256) still
       works for re-uploads of the same bytes, without colliding with
       real Graph message ids the inbox poller emits. */
    source_message_id: `manual:${auth.user.id}:${Date.now()}`,
    received_at: new Date().toISOString(),
    bytes,
    hint: file.name || `manual-${sourceType}.xlsx`,
    mime: file.type || MIME_BY_SOURCE[sourceType] || "application/octet-stream",
    user_id: auth.user.id,
    user_role: auth.user.role,
    class_override: classOverride ?? undefined,
  });

  return NextResponse.json({ ok: true, result });
}

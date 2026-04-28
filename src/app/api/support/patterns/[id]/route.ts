/**
 * PATCH /api/support/patterns/[id] — partial update of an operator-
 * editable pattern field. Used by the /support/patterns management UI.
 *
 * Patchable fields:
 *   - enabled                    (boolean)
 *   - auto_acknowledge_enabled   (boolean)
 *   - auto_acknowledge_template  (string | null)
 *
 * The seeded slug, name, category, match_signatures, and draft_template
 * are NOT operator-editable from the UI — those are the contract the
 * runtime matcher relies on. A request that includes any other field
 * returns 400 with `{ error: "invalid_field", field: "<name>" }` so a
 * typo never silently no-ops on the server.
 *
 * Auth: `automations.run` capability — same gate as GET /api/support/
 * patterns and the rest of the support endpoints.
 *
 * Analytics: `support.pattern_updated` fires on every successful PATCH
 * with the changed field set, so the learning system can correlate
 * auto-ack opt-in choices with eventual ticket outcomes.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { updatePattern } from "@/lib/support/repo";

const PATCHABLE_FIELDS = new Set<string>([
  "enabled",
  "auto_acknowledge_enabled",
  "auto_acknowledge_template",
]);

const BOOLEAN_FIELDS = new Set<string>([
  "enabled",
  "auto_acknowledge_enabled",
]);

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "automations.run");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "missing_body" }, { status: 400 });
  }

  /* Validate strictly: every key in the request must be patchable.
     Unknown fields -> 400 so the operator UI never silently fails to
     persist a column the backend doesn't recognize. */
  const b = body as Record<string, unknown>;
  for (const k of Object.keys(b)) {
    if (!PATCHABLE_FIELDS.has(k)) {
      return NextResponse.json(
        { error: "invalid_field", field: k },
        { status: 400 },
      );
    }
  }

  /* Type-check each field. Boolean fields must be booleans;
     auto_acknowledge_template must be string-or-null. Pass-through
     values with the wrong type would land in the DB as NULL or
     coerce to truthy garbage — a 400 here keeps writes honest. */
  const patch: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(b)) {
    if (BOOLEAN_FIELDS.has(k)) {
      if (typeof v !== "boolean") {
        return NextResponse.json(
          { error: "invalid_field_type", field: k, expected: "boolean" },
          { status: 400 },
        );
      }
      patch[k] = v;
    } else if (k === "auto_acknowledge_template") {
      if (v !== null && typeof v !== "string") {
        return NextResponse.json(
          { error: "invalid_field_type", field: k, expected: "string|null" },
          { status: 400 },
        );
      }
      patch[k] = v;
    }
  }

  if (Object.keys(patch).length === 0) {
    return NextResponse.json(
      { error: "no_fields_to_update" },
      { status: 400 },
    );
  }

  try {
    const { id } = await ctx.params;
    const updated = await updatePattern(id, patch);
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }

    trackEvent("support.pattern_updated", auth.user.id, auth.user.role, {
      pattern_id: id,
      pattern_slug: updated.slug,
      fields_changed: Object.keys(patch).join(","),
      auto_acknowledge_enabled:
        updated.auto_acknowledge_enabled === true,
    });

    return NextResponse.json({ pattern: updated });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 500 },
    );
  }
}

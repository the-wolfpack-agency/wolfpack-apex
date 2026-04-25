/**
 * GET /api/automations/[automationId]/summaries/[classKey]/merge-suggestions
 *
 * Find class_keys that probably refer to the same physical class as
 * the requested key — same course + same class_date but different
 * location. Used by the summary page to surface a merge suggestion
 * banner ("This might be the same class as BA102|2026-03-16|Atlanta —
 * merge?").
 *
 * Auth: `automations.view`.
 *
 * Already-merged keys (same equivalence class via class_match
 * overrides) are excluded from suggestions — once you've merged, the
 * banner stops nagging you.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { query } from "@/lib/db";
import { expandClassKeyEquivalence } from "@/lib/automations/porsche-classes/summary-assembler";

interface SuggestionRow {
  class_key: string;
  course_type: string;
  class_date: string;
  location: string;
  source_count: number;
}

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ automationId: string; classKey: string }> },
) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const { automationId, classKey: rawClassKey } = await ctx.params;
  const classKey = decodeURIComponent(rawClassKey);

  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json(
      { error: "automation not found" },
      { status: 404 },
    );
  }

  /* Parse the seed key. Format is `course|YYYY-MM-DD|location`. */
  const parts = classKey.split("|");
  if (parts.length !== 3) {
    return NextResponse.json(
      { error: "malformed class_key" },
      { status: 400 },
    );
  }
  const [course, classDate, location] = parts;

  /* Build the existing equivalence class so we can exclude it from
     suggestions — no point suggesting a merge that already happened. */
  const overrides = await query<{ from_value: string; to_value: string }>(
    `SELECT from_value, to_value
       FROM instinct_automation_porsche_overrides
      WHERE automation_id = 'porsche-classes'
        AND kind = 'class_match'`,
  );
  const alreadyMerged = new Set(
    expandClassKeyEquivalence(classKey, overrides.rows),
  );

  /* Probable duplicates: same course, same date, location differs.
     Group by class_key and count source_types so the UI can show "this
     other key has 2 sources, including a coordinator report". */
  const candidates = await query<SuggestionRow>(
    `SELECT class_key,
            course_type,
            class_date,
            location,
            COUNT(DISTINCT source_type)::int AS source_count
       FROM instinct_automation_porsche_snapshots
      WHERE course_type = $1
        AND class_date = $2
        AND class_key != $3
      GROUP BY class_key, course_type, class_date, location
      ORDER BY source_count DESC, class_key`,
    [course, classDate, classKey],
  );

  const suggestions = candidates.rows.filter(
    (r) => !alreadyMerged.has(r.class_key),
  );

  return NextResponse.json({
    seed: { class_key: classKey, course, class_date: classDate, location },
    suggestions,
    already_merged: [...alreadyMerged].filter((k) => k !== classKey),
  });
}

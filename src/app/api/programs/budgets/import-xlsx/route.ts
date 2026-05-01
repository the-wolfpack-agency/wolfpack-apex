/**
 * POST /api/programs/budgets/import-xlsx — drop a WPA xlsx in, get a
 * fully-populated budget out. Multipart-form file upload.
 *
 * Two modes:
 *   - no `?budgetId` → creates a brand-new budget header from the
 *     xlsx specs + bulk-inserts every detail line.
 *   - `?budgetId=…`  → bulk-inserts lines into an existing budget,
 *     leaving the header alone (use PATCH for spec changes).
 *
 * Section headers in the file are matched case-insensitively against
 * `instinct_program_budget_categories.name`. Unknown sections raise a
 * warning in the response so leadership can fix the doc instead of
 * silently dropping spend.
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import {
  createBudget,
  bulkCreateLines,
  getCategoryByName,
  listBudgetCategories,
  type CreateLineInput,
} from "@/lib/programs/budget-store";
import { parseBudgetXlsx } from "@/lib/programs/budget-xlsx";
import { trackEvent } from "@/lib/analytics";

export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const url = new URL(req.url);
  const targetBudgetId = url.searchParams.get("budgetId");

  let bytes: Uint8Array;
  try {
    const form = await req.formData();
    const file = form.get("file");
    if (!(file instanceof Blob)) {
      return NextResponse.json({ error: "file required" }, { status: 400 });
    }
    bytes = new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    return NextResponse.json(
      { error: `bad upload: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  let parsed;
  try {
    parsed = await parseBudgetXlsx(bytes);
  } catch (err) {
    return NextResponse.json(
      { error: `parse failed: ${(err as Error).message}` },
      { status: 400 },
    );
  }

  /* Resolve every section name to a category id once up-front so the
     line bulk-insert doesn't N+1. */
  const allCategories = await listBudgetCategories();
  const byName = new Map(
    allCategories.map((c) => [c.name.toLowerCase(), c]),
  );
  const unmatched = new Set<string>();
  const inputs: CreateLineInput[] = [];
  let budgetId = targetBudgetId || "";

  if (!budgetId) {
    try {
      const budget = await createBudget({
        name: parsed.specs.jobName || "Imported budget",
        jobNumber: parsed.specs.jobNumber,
        version: parsed.specs.version || "v1",
        specs: {
          weeks: parsed.specs.weeks,
          prepEventDays: parsed.specs.prepEventDays,
          markets: parsed.specs.markets,
          eventDays: parsed.specs.eventDays,
          teams: parsed.specs.teams,
          hotel: parsed.specs.hotel,
          ballroom: parsed.specs.ballroom,
          breakoutRooms: parsed.specs.breakoutRooms,
          tents: parsed.specs.tents,
          clearSpanFrame: parsed.specs.clearSpanFrame,
          vehicles: parsed.specs.vehicles,
          staticDisplay: parsed.specs.staticDisplay,
          drive: parsed.specs.drive,
          competitors: parsed.specs.competitors,
        },
        createdBy: user.id,
      });
      budgetId = budget.id;
      trackEvent("programBudget.created", user.id, user.role, {
        budget_id: budget.id,
        source: "xlsx_import",
      });
    } catch (err) {
      return NextResponse.json(
        { error: `create failed: ${(err as Error).message}` },
        { status: 400 },
      );
    }
  }

  let sortOrder = 0;
  for (const ln of parsed.lines) {
    /* Try exact-name first, then a parenthesized variant matched by
       the import file (e.g. "Project Management & Administration
       (Insurance)" → categories list under both forms). */
    let cat = byName.get(ln.category.toLowerCase());
    if (!cat) {
      const stripped = ln.category.replace(/\s*\([^)]*\)\s*$/, "").trim();
      cat = byName.get(stripped.toLowerCase());
    }
    if (!cat) {
      /* One more attempt: lookup by uppercase-or-as-is name via DB
         (handles small typo variants without tripping). */
      cat = (await getCategoryByName(ln.category)) ?? undefined;
    }
    if (!cat) {
      unmatched.add(ln.category);
      continue;
    }
    sortOrder += 10;
    inputs.push({
      budgetId,
      categoryId: cat.id,
      costCode: ln.costCode,
      responsibleUserId: ln.responsible,
      lineNumber: ln.lineNumber,
      description: ln.description,
      name: ln.name,
      units: ln.units,
      rate: ln.rate,
      sortOrder,
    });
  }

  let inserted = 0;
  if (inputs.length > 0) {
    try {
      inserted = await bulkCreateLines(inputs);
    } catch (err) {
      return NextResponse.json(
        { error: `bulk insert failed: ${(err as Error).message}` },
        { status: 400 },
      );
    }
  }

  trackEvent("programBudget.xlsx_imported", user.id, user.role, {
    budget_id: budgetId,
    line_count: inserted,
    unmatched_section_count: unmatched.size,
  });

  return NextResponse.json({
    budgetId,
    inserted,
    parsedLines: parsed.lines.length,
    unmatchedSections: Array.from(unmatched),
    warnings: parsed.warnings,
  });
}

/**
 * /api/automations/[automationId]/summaries/[classKey]/export-docx
 *
 * GET → Word .docx of the AssembledSummary for one class. 404 when no
 * snapshots yet, 404 when the automation is unknown / has no summary
 * assembler, 401 without `automations.view`.
 *
 * Mirrors the auth + class_key validation pattern of the JSON sibling
 * route at `../route.ts`. The docx renderer lives in a dedicated module
 * (`@/lib/automations/porsche-classes/export-docx`) so it stays
 * unit-testable in isolation; the route is just the integration glue.
 *
 * Today only `porsche-classes` ships an `assemble_summary`, but the
 * route is automation-id agnostic — any future automation that
 * registers an assembler can render to docx for free.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { renderClassSummaryDocx } from "@/lib/automations/porsche-classes/export-docx";

export async function GET(
  req: NextRequest,
  context: {
    params: Promise<{ automationId: string; classKey: string }>;
  },
) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const { automationId, classKey: rawClassKey } = await context.params;
  const classKey = decodeURIComponent(rawClassKey);

  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json(
      { error: "automation not found", automationId },
      { status: 404 },
    );
  }
  if (!automation.assemble_summary) {
    return NextResponse.json(
      {
        error: "automation does not implement summary assembly",
        automationId,
      },
      { status: 404 },
    );
  }

  let summary;
  try {
    summary = await automation.assemble_summary(classKey);
  } catch (err) {
    console.error(
      `[automations/${automationId}/summaries/${classKey}/export-docx] assembler threw:`,
      (err as Error).message,
    );
    return NextResponse.json(
      { error: "summary assembly failed", reason: "assembler_error" },
      { status: 500 },
    );
  }

  if (!summary) {
    return NextResponse.json(
      { error: "no snapshots for this class", classKey },
      { status: 404 },
    );
  }

  let docxBuffer: Buffer;
  try {
    docxBuffer = await renderClassSummaryDocx(summary);
  } catch (err) {
    console.error(
      `[automations/${automationId}/summaries/${classKey}/export-docx] render threw:`,
      (err as Error).message,
    );
    return NextResponse.json(
      { error: "docx render failed", reason: "render_error" },
      { status: 500 },
    );
  }

  // Sanitize the class_key for the download filename — `|` and `/` are
  // legal in HTTP header values once quoted but trip naïve clients on
  // some shells, so swap them for `_` (matches the JSON-download
  // sibling on the UI page).
  const filename = `class-summary-${classKey.replace(/[|/]/g, "_")}.docx`;

  // Hand off as Uint8Array so NextResponse gets a sized BodyInit (Buffer
  // is fine in Node but Uint8Array is the cross-runtime canonical form
  // and matches the artifact-download route's pattern).
  const view = new Uint8Array(docxBuffer.byteLength);
  view.set(docxBuffer);

  return new NextResponse(view, {
    status: 200,
    headers: {
      "Content-Type":
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(view.byteLength),
    },
  });
}

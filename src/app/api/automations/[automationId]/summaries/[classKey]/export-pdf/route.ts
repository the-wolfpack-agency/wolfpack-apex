/**
 * /api/automations/[automationId]/summaries/[classKey]/export-pdf
 *
 * GET → native PDF of the AssembledSummary for one class. 404 when no
 * snapshots yet, 404 when the automation is unknown / has no summary
 * assembler, 401 without `automations.view`.
 *
 * Mirrors the auth + class_key validation pattern of the .docx sibling
 * route at `../export-docx/route.ts`. The PDF renderer lives in a
 * dedicated module (`@/lib/automations/porsche-classes/export-pdf`) so
 * it stays unit-testable in isolation; this route is just integration
 * glue.
 *
 * Today only `porsche-classes` ships an `assemble_summary`, but the
 * route is automation-id agnostic — any future automation that
 * registers an assembler can render to PDF for free.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { renderClassSummaryPdf } from "@/lib/automations/porsche-classes/export-pdf";

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
      `[automations/${automationId}/summaries/${classKey}/export-pdf] assembler threw:`,
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

  let pdfBuffer: Buffer;
  try {
    pdfBuffer = await renderClassSummaryPdf(summary);
  } catch (err) {
    console.error(
      `[automations/${automationId}/summaries/${classKey}/export-pdf] render threw:`,
      (err as Error).message,
    );
    return NextResponse.json(
      { error: "pdf render failed", reason: "render_error" },
      { status: 500 },
    );
  }

  // Sanitize the class_key for the download filename — `|` and `/` are
  // legal in HTTP header values once quoted but trip naïve clients on
  // some shells, so swap them for `_` (matches the .docx + JSON
  // siblings on the UI page).
  const filename = `class-summary-${classKey.replace(/[|/]/g, "_")}.pdf`;

  // Hand off as Uint8Array so NextResponse gets a sized BodyInit (Buffer
  // is fine in Node but Uint8Array is the cross-runtime canonical form
  // and matches the .docx sibling).
  const view = new Uint8Array(pdfBuffer.byteLength);
  view.set(pdfBuffer);

  return new NextResponse(view, {
    status: 200,
    headers: {
      "Content-Type": "application/pdf",
      "Content-Disposition": `attachment; filename="${filename}"`,
      "Content-Length": String(view.byteLength),
    },
  });
}

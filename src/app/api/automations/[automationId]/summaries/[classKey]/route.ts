/**
 * /api/automations/[automationId]/summaries/[classKey]
 *
 * GET → AssembledSummary JSON for one class. 404 when no snapshots yet.
 *
 * Auth: requires `automations.view` (HR / Ops / Dev / CEO / CTO get it
 * by default, see role-capabilities.ts).
 *
 * Stream B owns this route. The `automationId` segment is part of the
 * generic Automations URL family — today only `porsche-classes` is
 * registered, but the route is config-driven so the next client
 * automation lights up by registering a new entry in the registry +
 * adding to the AutomationId union in `types.ts`.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { porscheClassesAutomation } from "@/lib/automations/porsche-classes";
import type { AutomationDefinition } from "@/lib/automations/types";

/**
 * Tiny inline registry so this route doesn't depend on Stream A's
 * `lib/automations/registry.ts` (which doesn't exist on this branch
 * yet). When Stream A's PR lands, the registry import replaces this
 * with one line; the assembler call site stays identical.
 */
const REGISTRY: Readonly<Record<string, AutomationDefinition>> = {
  "porsche-classes": porscheClassesAutomation,
};

export async function GET(
  req: NextRequest,
  context: {
    params: Promise<{ automationId: string; classKey: string }>;
  },
) {
  const auth = await requireCapability(req, "automations.view");
  if (!auth.ok) return auth.response;

  const { automationId, classKey: rawClassKey } = await context.params;
  // class_key is encoded in the URL because it contains `|` separators.
  const classKey = decodeURIComponent(rawClassKey);

  const automation = REGISTRY[automationId];
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
      `[automations/${automationId}/summaries/${classKey}] assembler threw:`,
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

  return NextResponse.json({ summary });
}

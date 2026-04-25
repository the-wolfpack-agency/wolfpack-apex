/**
 * POST /api/automations/[automationId]/exceptions/[exceptionId]/resolve
 *
 * Body shape:
 *   { outcome: "resolved" | "dismissed", note?: string }
 *
 * Auth: `automations.resolve_exceptions` capability required.
 *
 * Returns the updated exception row, or 404 if the row doesn't exist
 * or was already resolved.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAutomation } from "@/lib/automations/registry";
import { resolveException } from "@/lib/automations/queries";
import { trackEvent } from "@/lib/analytics";

const VALID_OUTCOMES = ["resolved", "dismissed"] as const;
type ValidOutcome = (typeof VALID_OUTCOMES)[number];

export async function POST(
  req: NextRequest,
  ctx: {
    params: Promise<{
      automationId: string;
      exceptionId: string;
    }>;
  },
) {
  const auth = await requireCapability(req, "automations.resolve_exceptions");
  if (!auth.ok) return auth.response;

  const { automationId, exceptionId } = await ctx.params;
  const automation = getAutomation(automationId);
  if (!automation) {
    return NextResponse.json({ error: "automation not found" }, { status: 404 });
  }

  let body: { outcome?: string; note?: string } = {};
  try {
    body = await req.json();
  } catch {
    // Empty body is acceptable — default to "resolved".
  }
  const outcomeRaw = body.outcome ?? "resolved";
  if (!(VALID_OUTCOMES as readonly string[]).includes(outcomeRaw)) {
    return NextResponse.json(
      { error: `outcome must be one of ${VALID_OUTCOMES.join(", ")}` },
      { status: 400 },
    );
  }
  const outcome = outcomeRaw as ValidOutcome;

  const updated = await resolveException({
    exceptionId,
    resolvedBy: auth.user.email,
    outcome,
  });
  if (!updated) {
    return NextResponse.json(
      { error: "exception not found or already resolved" },
      { status: 404 },
    );
  }

  trackEvent("automations.exception_resolved", auth.user.id, auth.user.role, {
    automation_id: automation.id,
    kind: updated.kind,
    outcome,
  });

  return NextResponse.json({ exception: updated });
}

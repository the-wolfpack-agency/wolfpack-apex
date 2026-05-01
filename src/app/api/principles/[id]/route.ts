/**
 * PATCH /api/principles/[id] — edit an active principle.
 * POST  /api/principles/[id]/retire — soft-delete (handled in
 *                                     ./retire/route.ts).
 */

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { canReadTeamEvidence } from "@/lib/principles/authz";
import { patchPrincipleNative } from "@/lib/principles/store";
import { evaluatePrinciples } from "@/lib/principles/evaluate-runner";
import { trackEvent } from "@/lib/analytics";

export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  if (!canReadTeamEvidence({ id: user.id, role: user.role })) {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  const { id } = await context.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "invalid JSON" }, { status: 400 });
  }
  try {
    const principle = await patchPrincipleNative({
      id,
      title: typeof body.title === "string" ? body.title : undefined,
      domains: Array.isArray(body.domains)
        ? (body.domains as string[])
        : undefined,
      owner: body.owner === null
        ? null
        : typeof body.owner === "string"
          ? body.owner
          : undefined,
      bodyMd: typeof body.bodyMd === "string" ? body.bodyMd : undefined,
      scoreboardWeight:
        typeof body.scoreboardWeight === "number"
          ? body.scoreboardWeight
          : undefined,
      effectiveAt: body.effectiveAt === null
        ? null
        : typeof body.effectiveAt === "string"
          ? body.effectiveAt
          : undefined,
      signals: Array.isArray(body.signals)
        ? (body.signals as string[])
        : undefined,
      counterSignals: Array.isArray(body.counterSignals)
        ? (body.counterSignals as string[])
        : undefined,
    });
    trackEvent("principle.updated", user.id, user.role, {
      principle_id: principle.id,
      slug: principle.slug,
    });
    /* Re-fan-out evaluation only when the signal set changed —
       cosmetic edits (title / body / weight) don't change which
       observations apply, so skip the cost. Fire-and-forget so a
       transient M365 hiccup never breaks the save flow. */
    const signalSetChanged =
      Array.isArray(body.signals) || Array.isArray(body.counterSignals);
    if (signalSetChanged) {
      void evaluatePrinciples([principle], { forceBootstrap: true }).catch(
        (err) => {
          trackEvent("principle.evaluation_failed", user.id, user.role, {
            stage: "post_update",
            principle_id: principle.id,
            error: (err as Error).message,
          });
        },
      );
    }
    return NextResponse.json({ principle });
  } catch (err) {
    return NextResponse.json(
      { error: (err as Error).message },
      { status: 400 },
    );
  }
}

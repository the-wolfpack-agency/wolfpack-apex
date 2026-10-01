/**
 * POST /api/admin/site-analytics/verdict-feedback
 *
 * An analyst marks a Forcefield hostile verdict as a FALSE POSITIVE (the operator
 * is not actually hostile). This is the trust loop on the agent-defense intel:
 * every "confirmed hostile" label must be correctable, and the correction must be
 * recorded so (a) the false-positive RATE is measurable and (b) the detection side
 * can learn from it. Capability: analytics.triage (an analyst decision). Audited
 * (hash chain) + emitted as a learning analytics event. No new store - analytics +
 * audit ARE the durable learning record.
 *
 *   200 { ok } | 400 invalid | 401/403 via requireCapability("analytics.triage")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "analytics.triage");
  if (!auth.ok) return auth.response;

  let body: { operatorKey?: unknown; findingKey?: unknown; reason?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const operatorKey = typeof body.operatorKey === "string" ? body.operatorKey.trim() : "";
  if (!operatorKey || operatorKey.length > 200) {
    return NextResponse.json({ error: "invalid_input", detail: "operatorKey required" }, { status: 400 });
  }
  const findingKey = typeof body.findingKey === "string" ? body.findingKey.slice(0, 200) : null;
  const reason = typeof body.reason === "string" ? body.reason.slice(0, 500) : null;

  // Learning signal: a verdict the detectors got wrong. Workspace-scoped.
  trackEvent("forcefield.verdict_false_positive", auth.user.id, auth.user.role, {
    workspace_id: auth.user.workspaceId,
    operatorKey,
    findingKey: findingKey ?? "",
    reason: reason ?? "",
  });

  // Marking a security verdict wrong is itself a security-relevant decision.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.verdict_false_positive",
    resourceType: "forcefield_verdict",
    resourceId: operatorKey,
    afterState: { findingKey: findingKey ?? undefined, reason: reason ?? undefined },
    ...extractRequestMetadata(req),
  });

  return NextResponse.json({ ok: true });
}

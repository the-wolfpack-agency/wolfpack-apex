/**
 * POST /api/admin/forcefield/signups/risk-summary { id }
 *
 * Operator decision aid: an AI risk/fit summary of ONE pending signup, to help an
 * operator approve or reject. Routed through the central model router (dogfood +
 * Model Limitation Profile telemetry). ADVISORY ONLY - it never changes the
 * request; the human still decides. The model call can cost money, so this is a
 * POST (gated, audited), not a cacheable GET.
 *
 * Capability: settings.manage_team (same as the review surface). Graceful: an
 * unavailable / over-budget / no-provider summary returns a typed 200 body the UI
 * shows inline, never a 5xx that would block the review.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { getSignupRequest } from "@/lib/forcefield-web/signup";
import { summarizeSignupRisk } from "@/lib/forcefield-web/signup-risk-summary";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const body = (await req.json().catch(() => ({}))) as { id?: unknown };
  const id = String(body.id ?? "");
  if (!id) return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });

  const request = await getSignupRequest(id);
  if (!request) return NextResponse.json({ ok: false, error: "not_found" }, { status: 404 });

  const result = await summarizeSignupRisk(
    { name: request.name, email: request.email, siteUrl: request.siteUrl, note: request.note },
    { workspaceId: auth.user.workspaceId, actor: { userId: auth.user.id, role: auth.user.role } },
  );

  // Audit the operator action (who asked for an AI summary on which request) - the
  // summary TEXT is not stored here; the router records the model/cost telemetry.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.signup_risk_summarized",
    resourceType: "forcefield_signup_request",
    resourceId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { available: result.ok, model: result.ok ? result.model : undefined },
  }).catch(() => {});

  // Always 200: advisory. The body carries either the summary or a typed reason.
  return NextResponse.json(result);
}

/**
 * /api/admin/ai-code/finding-review - the first human-in-the-loop gate label.
 *
 *   POST { findingClass, verdict, severity?, reason? }  -> 200 { ok, precision }
 *          verdict = wrong | valid | accepted_risk. Records a human's judgment of a
 *          gate finding (ai_code.gate_finding_reviewed) + returns the refreshed
 *          per-rule precision so the UI updates in place.
 *   GET    -> 200 { precision }   (per-rule precision read-model; ?days=N)
 *
 * This is the ground truth the FalsePositiveTracker needs: a class humans keep
 * marking `wrong` is noisy and can be demoted. We never infer a verdict.
 *
 * Capability: settings.manage_team. Entitlement: secure_agent. The review is a
 * deliberate human judgment, so it is audited (recordAuditNonFatal) + tracked.
 *
 * Returns: 200 | 400 (bad verdict/class) | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { trackEvent } from "@/lib/analytics";
import { recordAuditNonFatal, extractRequestMetadata } from "@/lib/audit-log";
import { loadGatePrecision, REVIEW_VERDICTS, type ReviewVerdict } from "@/lib/ai-code/gate-precision";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;
  const daysRaw = Number(new URL(req.url).searchParams.get("days"));
  const days = Number.isFinite(daysRaw) && daysRaw > 0 ? daysRaw : 30;
  const precision = await loadGatePrecision(resolveWorkspace(auth.user.workspaceId), days);
  return NextResponse.json({ precision }, { status: 200 });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? (await requireCapability(req, "settings.manage_team"));
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { findingClass?: unknown; verdict?: unknown; severity?: unknown; reason?: unknown };
  const findingClass = typeof b.findingClass === "string" ? b.findingClass.trim() : "";
  const verdict = typeof b.verdict === "string" ? b.verdict : "";
  if (!findingClass) return NextResponse.json({ error: "findingClass is required" }, { status: 400 });
  if (!REVIEW_VERDICTS.includes(verdict as ReviewVerdict)) {
    return NextResponse.json({ error: `verdict must be one of ${REVIEW_VERDICTS.join(", ")}` }, { status: 400 });
  }
  const workspaceId = resolveWorkspace(auth.user.workspaceId);
  const severity = typeof b.severity === "string" ? b.severity : "";

  trackEvent("ai_code.gate_finding_reviewed", auth.user.id, auth.user.role, {
    workspace_id: workspaceId,
    finding_class: findingClass,
    verdict,
    ...(severity ? { severity } : {}),
  });

  const meta = extractRequestMetadata(req);
  await recordAuditNonFatal({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.gate_finding.reviewed",
    resourceType: "gate_finding",
    resourceId: `${workspaceId}:${findingClass}`,
    // the reason is a free-text human note; keep it short + it's not a secret surface
    afterState: { workspace_id: workspaceId, finding_class: findingClass, verdict, reason: typeof b.reason === "string" ? b.reason.slice(0, 280) : undefined },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  });

  const precision = await loadGatePrecision(workspaceId, 30);
  return NextResponse.json({ ok: true, precision }, { status: 200 });
}

/**
 * POST /api/admin/site-analytics/operator/promote { operatorKey }
 *
 * Promote a consolidated operator to the persistent operators board: record each
 * of its current journeys as a Sighting, so its dossier accumulates ACROSS visits
 * and days instead of living only in the current window. Server-authoritative -
 * it recomputes the summary from the DB and never trusts client-supplied sighting
 * data. Capability-gated + audited (promoting shapes the operators intelligence).
 *
 *   200 { ok, promoted } | 400 invalid | 404 operator not found | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getSiteAnalyticsSummary } from "@/lib/site-analytics";
import { consolidateByOperator } from "@/lib/agent-operators-view";
import { liveSightingFor } from "@/lib/agent-profile";
import { recordSighting } from "@/lib/agent-operators";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

const SURFACE = "ogiam.com";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "analytics.triage");
  if (!auth.ok) return auth.response;

  let body: { operatorKey?: unknown } = {};
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const operatorKey = typeof body.operatorKey === "string" ? body.operatorKey.trim() : "";
  if (!operatorKey || operatorKey.length > 200) return NextResponse.json({ error: "invalid_body" }, { status: 400 });

  const workspaceId = auth.user.workspaceId ?? "default";
  const summary = await getSiteAnalyticsSummary(30, workspaceId);
  const group = consolidateByOperator(summary.journeys).find((g) => g.operatorKey === operatorKey);
  if (!group) return NextResponse.json({ error: "operator_not_found" }, { status: 404 });

  let promoted = 0;
  for (const j of group.journeys) {
    try {
      await recordSighting({ workspaceId, sighting: liveSightingFor(j, SURFACE) });
      promoted += 1;
    } catch {
      /* one failed sighting must not abort the promotion; record what we can */
    }
  }

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "operator.promoted_to_board",
    resourceType: "agent_operator",
    resourceId: operatorKey,
    afterState: { promoted, findings: group.journeys.length, severity: group.severity },
    ...extractRequestMetadata(req),
  });

  return NextResponse.json({ ok: true, promoted });
}

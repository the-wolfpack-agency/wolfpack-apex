/**
 * POST /api/admin/site-analytics/triage
 *
 * Set the triage state of one agent-journey finding (acknowledge / escalate /
 * dismiss / reset to new). Capability-gated + audited: dismissing a threat
 * finding is a security-relevant decision, so it is written to the hash-chained
 * audit log.
 *
 *   200 { ok, status }
 *   400 invalid body
 *   401 / 403 via requireCapability("analytics.triage")
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { setFindingTriage, isTriageStatus } from "@/lib/site-finding-triage";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "analytics.triage");
  if (!auth.ok) return auth.response;

  let body: { findingKey?: unknown; status?: unknown; note?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const findingKey = typeof body.findingKey === "string" ? body.findingKey.trim() : "";
  const status = body.status;
  const note = typeof body.note === "string" ? body.note.slice(0, 500) : null;
  if (!findingKey || findingKey.length > 200 || !isTriageStatus(status)) {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  await setFindingTriage({ workspaceId: auth.user.workspaceId, findingKey, status, note, updatedBy: auth.user.id });

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "site_analytics.finding_triaged",
    resourceType: "site_finding",
    resourceId: findingKey,
    afterState: { status, note: note ?? undefined },
    ...extractRequestMetadata(req),
  });

  return NextResponse.json({ ok: true, status });
}

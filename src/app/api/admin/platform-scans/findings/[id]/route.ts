import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { triageFinding } from "@/lib/platform-scan/store";

const TRIAGE_STATUSES = ["acknowledged", "resolved"] as const;
type TriageStatus = (typeof TRIAGE_STATUSES)[number];

/**
 * POST /api/admin/platform-scans/findings/[id]  body: { status }
 *
 * Triages a single scan finding to "acknowledged" or "resolved", attributed to
 * the deciding admin. Gated on settings.manage_team. The store scopes the
 * update by workspace, so a finding in another workspace returns 404.
 */
export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";
  const { id } = await ctx.params;

  let body: { status?: string };
  try {
    body = (await req.json()) as { status?: string };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const status = body.status;
  if (!TRIAGE_STATUSES.includes(status as TriageStatus)) {
    return NextResponse.json(
      { error: "status must be 'acknowledged' or 'resolved'" },
      { status: 400 },
    );
  }

  const finding = await triageFinding(
    id,
    workspaceId,
    status as TriageStatus,
    user.id,
    user.role,
  );
  if (!finding) {
    return NextResponse.json({ error: "finding not found" }, { status: 404 });
  }

  // Audit the triage decision (hash-chained, immutable). Best effort.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.finding_triaged",
    resourceType: "platform_scan_finding",
    resourceId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { status, route: finding.route, severity: finding.severity },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, finding });
}

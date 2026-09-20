/**
 * GET/POST /api/admin/forcefield/audit-anchor
 *
 * GET  -> anchor status + live verification against every published anchor
 *         (detects DB tampering: a mismatch means a row was rewritten after we
 *         published it).
 * POST -> publish the current chain head to the external witness now.
 * Capability-gated ("settings.manage_team"); publishing is audited.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { anchorStatus, verifyExternalAnchors, publishAuditAnchor } from "@/lib/forcefield/audit-anchor";
import { recordAudit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const [status, verify] = await Promise.all([anchorStatus(), verifyExternalAnchors()]);
  return NextResponse.json({ status, verify });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const anchor = await publishAuditAnchor();
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.audit_anchor_published",
    resourceType: "audit_anchor",
    resourceId: anchor ? String(anchor.seq) : "none",
    afterState: anchor ? { seq: anchor.seq, delivered: anchor.delivered } : { published: false },
  }).catch(() => {});
  return NextResponse.json({ ok: true, anchor });
}

/**
 * /api/admin/compliance/report/export — forwardable, SIGNED evidence export.
 *
 *   GET ?id=<reportId>[&format=html]
 *     -> fetch the stored report scoped to the caller's workspace, build the
 *        signed canonical-JSON artifact (+ detached signature + verification
 *        metadata + a printable HTML view), and return it.
 *
 * The CISO/auditor receives a verifiable artifact instead of a login. The
 * signature covers the full canonical payload; a tampered payload fails
 * verification (see src/lib/compliance/export.ts -> verifyEvidenceExport).
 *
 * Read-derived (serializes + signs an EXISTING report; no domain mutation), so
 * it is audit-allowlisted and emits compliance.evidence_exported. Workspace-
 * scoped via getReportById(workspaceId, id) so one workspace can never export
 * another's report (no IDOR). Capability: settings.manage_team.
 *
 * Returns: 200 (artifact JSON, or text/html when format=html) | 400 (missing id)
 *          | 404 (unknown report id for this workspace) | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getReportById } from "@/lib/compliance/store";
import { buildEvidenceExport } from "@/lib/compliance/export";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const id = url.searchParams.get("id");
  if (!id) {
    return NextResponse.json({ error: "id query parameter is required" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  // Workspace-scoped fetch: a report id from another workspace returns null ->
  // 404, never another tenant's evidence (no IDOR).
  const stored = await getReportById(workspaceId, id);
  if (!stored) {
    return NextResponse.json({ error: "report not found" }, { status: 404 });
  }

  const artifact = await buildEvidenceExport({
    reportId: stored.id,
    workspaceId: stored.workspaceId,
    report: stored.report,
    generatedAt: stored.createdAt,
  });

  trackEvent("compliance.evidence_exported", auth.user.id, auth.user.role, {
    framework: stored.framework,
    report_id: stored.id,
    signed: artifact.signature.signed,
  });

  // Printable view: same facts, rendered from the signed payload.
  if (url.searchParams.get("format") === "html") {
    return new NextResponse(artifact.html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "content-disposition": `attachment; filename="compliance-evidence-${stored.framework}-${stored.id}.html"`,
      },
    });
  }

  return NextResponse.json(artifact, {
    status: 200,
    headers: {
      "content-disposition": `attachment; filename="compliance-evidence-${stored.framework}-${stored.id}.json"`,
    },
  });
}

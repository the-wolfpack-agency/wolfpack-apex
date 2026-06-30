/**
 * /api/admin/compliance/report — generate framework compliance evidence.
 *
 *   POST { framework } -> collect live OGIAM evidence, crosswalk it to the
 *                         framework's controls, persist + return the report.
 *   GET                 -> recent report history for the workspace.
 *
 * The status of every control is DERIVED from measured evidence (audit chain,
 * gate decisions, red-team pass rate, the ungoverned-AI gap), never asserted, so
 * the output is honest and auditable. Read-derived (no domain mutation) -
 * audit-allowlisted - and emits compliance.report_generated + a gap event per
 * uncovered control. Capability: settings.manage_team.
 *
 * Returns: 200 { report } | 400 (bad framework) | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { runComplianceReport } from "@/lib/compliance/orchestrate";
import { listReports } from "@/lib/compliance/store";
import { ALL_FRAMEWORKS } from "@/lib/compliance/frameworks";
import type { ComplianceFramework } from "@/lib/compliance/types";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const reports = await listReports(auth.user.workspaceId ?? "default");
  return NextResponse.json({ reports });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const framework = (body as { framework?: unknown })?.framework as ComplianceFramework;
  if (!ALL_FRAMEWORKS.includes(framework)) {
    return NextResponse.json(
      { error: `framework must be one of ${ALL_FRAMEWORKS.join(", ")}` },
      { status: 400 },
    );
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  const { report } = await runComplianceReport(workspaceId, framework, new Date().toISOString());

  trackEvent("compliance.report_generated", auth.user.id, auth.user.role, {
    framework,
    coverage: report.coverage,
    covered: report.covered,
    partial: report.partial,
    gap: report.gap,
  });
  for (const c of report.controls.filter((c) => c.status === "gap")) {
    trackEvent("compliance.gap_detected", auth.user.id, auth.user.role, { framework, control_id: c.id });
  }

  return NextResponse.json({ report });
}

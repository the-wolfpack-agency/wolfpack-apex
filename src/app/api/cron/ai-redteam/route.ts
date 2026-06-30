/**
 * GET /api/cron/ai-redteam — the continuous AI red-team sweep.
 *
 * Runs the adversarial corpus against the OGIAM gate on a schedule and records
 * the result. The healthy state is zero vulns (the gate blocks every attack); a
 * vuln means a policy regression let an attack through and is recorded as a
 * CRITICAL-risk run plus an ai_redteam.vuln_detected event, so the regression is
 * caught continuously rather than at a client demo. Deterministic + offline (no
 * live model, no network, no cost), so running it often is free and safe.
 *
 * Two auth paths (mirrors /api/cron/demo-canary): a CRON_SECRET bearer for Vercel
 * Cron, or settings.manage_team for an admin manual run. Never 500s on a
 * recoverable error: the result IS the signal, returned in the body.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { executeRedTeam } from "@/lib/ai-redteam/execute";

function isAuthorizedCron(req: NextRequest): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return (req.headers.get("authorization") ?? "") === `Bearer ${secret}`;
}

async function run(workspaceId: string, actorId: string, actorRole: string): Promise<NextResponse> {
  const { report, id } = await executeRedTeam({
    workspaceId,
    actorId,
    actorRole,
    source: "cron",
    nowIso: new Date().toISOString(),
  });
  if (report.vulns.length > 0) {
    // A gate regression is a security event the team must see immediately.
    console.warn(`[ai-redteam] REGRESSION: ${report.vulns.length} attack(s) got through`, report.vulns.map((v) => v.attackId));
  }
  return NextResponse.json({
    ok: true,
    runId: id,
    attacks: report.attacksRun,
    blocked: report.blocked,
    vulns: report.vulns.length,
    passRate: report.passRate,
    healthy: report.vulns.length === 0,
  });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  if (isAuthorizedCron(req)) {
    return run("default", "cron", "system");
  }
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  return run(auth.user.workspaceId ?? "default", auth.user.id, auth.user.role);
}

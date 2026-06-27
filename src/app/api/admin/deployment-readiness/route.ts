import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import {
  runDeploymentReadiness,
  defaultReadinessDeps,
} from "@/lib/deploy/deployment-readiness";

/**
 * GET /api/admin/deployment-readiness -> verify a deployment's env blockers are
 * present AND its backing services (Postgres / Qdrant / Neo4j / GitHub) are
 * reachable BEFORE it goes live, so it never crash-loops or silently half-works
 * from a missing var or a down store. All checks are read-only and non-
 * destructive; no secret VALUES are ever returned. The run is audited and tracked
 * so onboarding friction (which checks fail, how often) feeds the learning loop.
 *
 * Mirrors the platform-scans preflight route idiom: capability gate, run the lib,
 * trackEvent + recordAudit, return the result verbatim.
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const result = await runDeploymentReadiness(defaultReadinessDeps());
  const failed = result.checks.filter((c) => !c.pass).map((c) => c.name);

  trackEvent("platform.deployment_readiness_checked", user.id, user.role, {
    ok: result.ok,
    checks: result.checks.length,
    failed: failed.join(",") || "none",
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.deployment_readiness_checked",
    resourceType: "deployment",
    resourceId: workspaceId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
    afterState: { workspaceId, ok: result.ok, failed },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json(result);
}

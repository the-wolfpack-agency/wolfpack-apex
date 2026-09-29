/**
 * POST /api/admin/ai-code/baseline  { repo, base, workflow? }
 *
 * Establish a baseline for a repo whose base branch has no measured CI: dispatch
 * a workflow on the base ref so its health becomes measurable. Without a baseline
 * there is no way to later attribute a failure to the factory vs the repo itself,
 * so this is the deliberate "determine the initial system state" action offered by
 * the onboarding readiness preflight (its baseline-health fix).
 *
 * Capability + secure_agent entitlement gated. Never 500s on a dispatch failure:
 * the reason (e.g. the workflow is not workflow_dispatch-enabled) is returned.
 * Returns: 200 { result } | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { establishBaseline } from "@/lib/ai-code/ci-status";
import { trackEvent } from "@/lib/analytics";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let b: { repo?: unknown; base?: unknown; workflow?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  const base = typeof b.base === "string" ? b.base.trim() : "";
  const workflow = typeof b.workflow === "string" && b.workflow.trim() ? b.workflow.trim() : undefined;
  if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }
  if (!base) return NextResponse.json({ error: "base is required" }, { status: 400 });

  const result = await establishBaseline(repo, base, {
    workflowFile: workflow,
    workspaceId: auth.user.workspaceId ?? undefined,
  });
  trackEvent("ai_code.baseline_established", auth.user.id, auth.user.role, {
    repo,
    workflow: result.workflowFile,
    dispatched: result.dispatched,
  });
  return NextResponse.json({ result });
}

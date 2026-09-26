/**
 * POST /api/admin/ai-code/ci-fix  { repo, ref, attempt?, maxAttempts? }
 *
 * One step of the read-CI-and-fix-until-green loop for a factory PR: read the
 * PR's CI, decide the next action (merge_ready / wait / author_fix /
 * escalate_human), and when a fix is due, return the fix brief the executor
 * acts on. A poller / webhook calls this repeatedly until it returns merge_ready
 * or escalate_human. The DECISION is deterministic; authoring + committing the
 * fix (which edits existing files) is the workspace stage and is the caller's
 * job today.
 *
 * Read-only itself. Capability + secure_agent entitlement gated.
 * Returns: 200 { decision, ci, brief? } | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { fetchCiStatus } from "@/lib/ai-code/ci-status";
import { decideFixAction, buildFixBrief } from "@/lib/ai-code/ci-fix-loop";

const MAX_ATTEMPTS_CEILING = 5;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let b: { repo?: unknown; ref?: unknown; attempt?: unknown; maxAttempts?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  if (!repo || !ref) return NextResponse.json({ error: "repo and ref are required" }, { status: 400 });

  const attempt = typeof b.attempt === "number" && Number.isFinite(b.attempt) ? Math.max(0, Math.floor(b.attempt)) : 0;
  const maxAttempts =
    typeof b.maxAttempts === "number" && Number.isFinite(b.maxAttempts)
      ? Math.max(1, Math.min(MAX_ATTEMPTS_CEILING, Math.floor(b.maxAttempts)))
      : 3;

  const ci = await fetchCiStatus(repo, ref, auth.user.workspaceId ?? undefined);
  const decision = decideFixAction({ ci, attempt, maxAttempts });
  const brief = decision.action === "author_fix" ? buildFixBrief(ci.failedDetails) : undefined;

  return NextResponse.json({ decision, ci, ...(brief ? { brief } : {}) });
}

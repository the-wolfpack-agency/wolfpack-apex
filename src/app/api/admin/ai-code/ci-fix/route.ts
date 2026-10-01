/**
 * POST /api/admin/ai-code/ci-fix  { repo, ref, branch?, base?, attempt?, maxAttempts? }
 *
 * One step of the read-CI-and-fix-until-green loop for a factory PR - the
 * INTERACTIVE front door. The loop itself lives in driveCiFixStep (ci-fix-runner)
 * so the autonomous watcher (Vercel cron) drives PRs through the exact same code
 * path; this route only adds auth + request validation.
 *
 *  - Without `branch`: DECIDE only (merge_ready / wait / author_fix /
 *    escalate_human) and, when a fix is due, return the brief.
 *  - With `branch`: DRIVE it. On a red CI with budget left, re-author the fix and
 *    COMMIT it to the PR branch (which re-triggers CI). A poller / webhook / the
 *    watcher calls this repeatedly until `terminal` is true (green or a human).
 *
 * The decision is deterministic (ci-fix-loop); the AI author is model-agnostic
 * (the router, tier-selected). Capability + secure_agent entitlement gated.
 * Returns: 200 { decision, ci, fix?, terminal?, brief? } | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { factoryServiceAuth } from "@/lib/ai-code/factory-service-auth";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { driveCiFixStep } from "@/lib/ai-code/ci-fix-runner";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = factoryServiceAuth(req) ?? await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let b: { repo?: unknown; ref?: unknown; branch?: unknown; base?: unknown; attempt?: unknown; maxAttempts?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const branch = typeof b.branch === "string" ? b.branch.trim() : "";
  const base = typeof b.base === "string" ? b.base.trim() : "";
  if (!repo || !ref) return NextResponse.json({ error: "repo and ref are required" }, { status: 400 });
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }
  const attempt = typeof b.attempt === "number" && Number.isFinite(b.attempt) ? b.attempt : 0;
  const maxAttempts = typeof b.maxAttempts === "number" && Number.isFinite(b.maxAttempts) ? b.maxAttempts : 3;

  const { status, body } = await driveCiFixStep({
    repo,
    ref,
    branch,
    base,
    attempt,
    maxAttempts,
    workspaceId: auth.user.workspaceId ?? undefined,
    actor: { userId: auth.user.id, role: auth.user.role },
  });
  return NextResponse.json(body, { status });
}

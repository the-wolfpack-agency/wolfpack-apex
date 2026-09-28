/**
 * POST /api/admin/ai-code/pre-pr-validate  { repo, changes, base?, ref }
 *
 * The pre-PR validation ORCHESTRATION: push an authored change to a throwaway
 * validation branch and run the pre-pr-validate gate on it, so a change's OWN
 * authored tests are EXECUTED before a real PR is ever opened. A poller calls
 * this repeatedly:
 *   require_human "dispatched"/"pending" -> keep polling
 *   allow                                 -> validated; open the real PR now
 *   require_human "self-inconsistent"     -> STOP; the authored tests fail (a wrong
 *                                            test or broken code) - never open a
 *                                            looping PR.
 *
 * The push is idempotent (content-hashed branch, pushed once). Each gate decision
 * is on the OGIAM hash-chained ledger. Capability + secure_agent gated.
 * Returns 200 { branch, verdict, reason, output } | 400 | 401/403.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { workspaceGithubClient } from "@/lib/github-client";
import { pushValidationBranch } from "@/lib/ai-code/pre-pr-validation";
import { getGate } from "@/lib/gates/registry";
import { runGate } from "@/lib/gates/run-gate";
import { recordGateDecision } from "@/lib/gates/audit";
import { DEFAULT_COMPLIANCE_POLICY } from "@/lib/gates/types";
import type { FileChange } from "@/lib/ai-code/file-changes";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let b: { repo?: unknown; changes?: unknown; base?: unknown; ref?: unknown };
  try {
    b = (await req.json()) as typeof b;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const repo = typeof b.repo === "string" ? b.repo.trim() : "";
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const base = typeof b.base === "string" && b.base.trim() ? b.base.trim() : "main";
  if (!repo || !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }
  if (!ref) return NextResponse.json({ error: "ref is required" }, { status: 400 });
  const changes = Array.isArray(b.changes)
    ? (b.changes.filter((c): c is FileChange => !!c && typeof (c as FileChange).path === "string" && typeof (c as FileChange).content === "string"))
    : [];
  if (changes.length === 0) return NextResponse.json({ error: "changes must be a non-empty array of { path, content }" }, { status: 400 });

  const workspaceId = auth.user.workspaceId ?? "default";
  const client = await workspaceGithubClient(workspaceId);
  if (!client.token) return NextResponse.json({ error: "no GitHub token for validation" }, { status: 400 });

  // Push the authored change to a validation branch (once), then run the gate.
  const branch = await pushValidationBranch(client, repo, changes, base, ref);
  const def = getGate("pre-pr-validate");
  if (!def) return NextResponse.json({ error: "pre-pr-validate gate not available" }, { status: 400 });

  const ctx = { workspaceId, actorId: auth.user.id, policy: DEFAULT_COMPLIANCE_POLICY };
  const result = await runGate(def, { repo, branch }, ctx);
  const { recordedSeq } = await recordGateDecision("pre-pr-validate", result, ctx, { repo, branch });

  return NextResponse.json({
    branch,
    verdict: result.verdict,
    reason: result.reason,
    output: result.output,
    recordedSeq,
  });
}

/**
 * POST /api/admin/ai-code/ci-fix  { repo, ref, branch?, attempt?, maxAttempts? }
 *
 * One step of the read-CI-and-fix-until-green loop for a factory PR.
 *
 *  - Without `branch`: DECIDE only (merge_ready / wait / author_fix /
 *    escalate_human) and, when a fix is due, return the brief. Legacy behavior.
 *  - With `branch`: DRIVE it. On a red CI with budget left, re-author the fix and
 *    COMMIT it to the PR branch (which re-triggers CI). A poller / webhook calls
 *    this repeatedly until `terminal` is true (green or handed to a human).
 *
 * The decision is deterministic (ci-fix-loop); authoring + committing is the
 * driver (ci-fix-driver). Capability + secure_agent entitlement gated.
 * Returns: 200 { decision, ci, fix?, terminal?, brief? } | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { fetchCiStatus, fetchCiAttribution } from "@/lib/ai-code/ci-status";
import { decideFixAction, buildFixBrief } from "@/lib/ai-code/ci-fix-loop";
import { runCiFixStep } from "@/lib/ai-code/ci-fix-driver";
import { workspaceGithubClient, getBranchHead } from "@/lib/github-client";
import { gatherFailureContext, buildEnrichedFixPrompt } from "@/lib/ai-code/ci-failure-detail";
import { commitFileChanges, filesToDiff } from "@/lib/ai-code/file-changes";
import { assessChange } from "@/lib/ai-code/assess";
import { authorFileChanges } from "@/lib/ai-code/author";
import { getAIClient } from "@/lib/ai";

const MAX_ATTEMPTS_CEILING = 5;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
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

  const workspaceId = auth.user.workspaceId ?? undefined;
  const attempt = typeof b.attempt === "number" && Number.isFinite(b.attempt) ? Math.max(0, Math.floor(b.attempt)) : 0;
  const maxAttempts =
    typeof b.maxAttempts === "number" && Number.isFinite(b.maxAttempts)
      ? Math.max(1, Math.min(MAX_ATTEMPTS_CEILING, Math.floor(b.maxAttempts)))
      : 3;

  // Read CI for the PR HEAD (the branch), where the checks actually ran - NOT the
  // task-id `ref`, which is not a git ref and would 404. Fall back to ref only
  // when no branch is given (a decide-only caller must pass a real ref then).
  const ciRef = branch || ref;
  const ci = await fetchCiStatus(repo, ciRef, workspaceId);

  // Baseline attribution: when a base branch is named, only the failures this
  // change INTRODUCED are the fixer's to repair. Pre-existing red is not touched
  // (the fixer did not break it), and the fix brief targets only introduced
  // checks. Without a base, the fixer stays baseline-unaware (fixes any red).
  const attribution = base ? await fetchCiAttribution(repo, base, ciRef, workspaceId) : null;
  const introducedFailing = attribution ? attribution.introduced.length : undefined;
  const briefDetails = attribution
    ? ci.failedDetails.filter((d) => attribution.introduced.includes(d.name))
    : ci.failedDetails;

  // Decide-only when there is no branch to commit a fix to.
  if (!branch) {
    const decision = decideFixAction({ ci, attempt, maxAttempts, introducedFailing });
    const brief = decision.action === "author_fix" ? buildFixBrief(briefDetails) : undefined;
    return NextResponse.json({ decision, ci, ...(attribution ? { attribution } : {}), ...(brief ? { brief } : {}) });
  }

  // Drive it: author the fix and commit to the PR branch.
  const ai = getAIClient();
  const client = await workspaceGithubClient(workspaceId ?? "default");
  if (!client.token) {
    // Cannot commit without a token; fall back to a decision the caller can act on.
    const decision = decideFixAction({ ci, attempt, maxAttempts, introducedFailing });
    return NextResponse.json({ decision, ci, terminal: decision.action !== "author_fix", note: "no GitHub token; decision only" });
  }

  // Observability: what failure context the fixer actually gathered (so a "no fix"
  // is diagnosable - did it see the error + files, or nothing?).
  let contextSummary: { detailChars: number; files: string[] } | null = null;
  const result = await runCiFixStep({
    ci,
    attempt,
    maxAttempts,
    introducedFailing,
    briefDetails,
    reauthor: async (brief) => {
      // Enrich the re-author with what a human would look at: the branch head's
      // ACTUAL failure detail (the failing job's error lines) and the current
      // contents of the files that error points at. Without this the model has
      // only a check name and produces nothing usable (found by dogfooding).
      const headSha = await getBranchHead(client, repo, branch).catch(() => branch);
      const context = await gatherFailureContext(client, repo, headSha, branch);
      contextSummary = { detailChars: context.detail.length, files: context.files.map((f) => f.path) };
      const prompt = buildEnrichedFixPrompt({ repo, branch, brief, context });
      const authored = await authorFileChanges(
        { prompt, feature: "ai-code-ci-fix" },
        { complete: (r) => ai.complete(r) },
      );
      return { changes: authored.changes, author: authored.author, error: authored.error };
    },
    // The autonomous fix clears the SAME combined gate as the front door before it
    // is committed. A fix carrying a secret / injection / critical finding is never
    // pushed to the PR branch; the step escalates to a human.
    gate: async (changes) => {
      const a = await assessChange(filesToDiff(changes));
      return { cleared: a.handoffAllowed, blockedBy: a.blockedBy };
    },
    commit: (changes) =>
      commitFileChanges({ client, repoFullName: repo, branch, base: branch, changes, message: `factory ci-fix: ${ref}` }),
  });

  return NextResponse.json({ ...result, context: contextSummary });
}

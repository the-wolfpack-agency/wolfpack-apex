/**
 * /api/admin/ai-code/pipeline — one governed run over an AI-authored change.
 *
 *   POST { ref, prompt, answers?, diff?, author?, authorModel?, executorProviderPin?, maxAttempts? }
 *        -> EXECUTOR (no diff supplied -> a model authors it from the prompt;
 *           input-to-output) -> intake (fixed multiple-choice -> frozen spec) ->
 *           the deterministic gate -> Stage 2 re-route repair on a non-allow
 *           verdict (a DIFFERENT lineage than the executor). Returns a run
 *           that is READY FOR PR only when the gate allowed the final diff (the
 *           original or a repaired one it re-checked), otherwise needs_human.
 *           This route never merges: a human opens the PR.
 *
 * Capability: settings.manage_team. Hash-chain AUDITED and emits
 * ai_code.pipeline_run for the learning loop. An off-menu intake answer is a 400
 * (the answer space is fixed), not a 500.
 *
 * Returns: 200 { run } | 400 (bad body / off-menu answer) | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { runCodeReview } from "@/lib/ai-code/scan";
import { liveRepairComplete } from "@/lib/ai-code/repair";
import { runPipeline } from "@/lib/ai-code/pipeline";
import { authorDiff, authorFileChanges } from "@/lib/ai-code/author";
import { filesToDiff, type FileChange } from "@/lib/ai-code/file-changes";
import { remediateFileChanges } from "@/lib/ai-code/repair-files";
import { buildRegistry, judgeCandidates } from "@/lib/ai/router";
import { chooseIndependentJudge } from "@/lib/ai/judge-selection";
import { evaluateChangeInvariants } from "@/lib/ai-code/change-facts";
import { deepScanChange } from "@/lib/ai-code/deep-scan";
import { buildRunCost } from "@/lib/ai-code/cost";
import { workspaceGithubClient } from "@/lib/github-client";
import { buildRepoContext, withRepoContext } from "@/lib/ai-code/repo-context";
import { getAIClient } from "@/lib/ai";
import type { AIModelTier } from "@/lib/ai/types";
import { DEFAULT_SPEC_QUESTIONS } from "@/lib/ai-code/intake";
import { createPendingApproval } from "@/lib/agents/approvals/store";
import type { CodeReviewResult } from "@/lib/ai-code/types";

const MAX_DIFF = 2_000_000; // chars
const MAX_ATTEMPTS_CAP = 4;
/** The stable principal the Code Gate captures its PR handoffs under, so they
 *  surface in the agent-approvals surface. agent_id is a plain TEXT column (no
 *  FK), so this needs no agent-principal row. */
const CODE_GATE_AGENT_ID = "ai-code-gate";
/** The fixed answer-key allowlist. The route always runs the default questions,
 *  so a valid answer names one of these; anything else is dropped, never used as
 *  a property name to write. */
const SPEC_QUESTION_IDS = new Set(DEFAULT_SPEC_QUESTIONS.map((q) => q.id));

/** Common executor evidence (both authoring modes carry these). */
type ExecutorEvidence = { author: string; provider: string | null; costUsd: number | null; latencyMs: number | null; inputTokens: number | null; outputTokens: number | null; error: string | null };

/**
 * Resolve the change the pipeline will govern. Three sources, all feeding the
 * SAME gate (authoring is a feature, not a security check):
 *  - supplied diff (governed as-is)
 *  - files mode: the executor authors FULL FILE CONTENTS (edit-support); the
 *    review substrate is a synthesized diff, and `changes` carries the files for
 *    the commit
 *  - diff mode (default): the executor authors a unified diff (new files)
 */
async function resolveChange(args: {
  mode: "diff" | "files";
  diff: string;
  prompt: string;
  authorModel: string;
  executorProviderPin?: string;
  tier?: AIModelTier;
}): Promise<{ diff: string; author: string; executor: ExecutorEvidence | null; changes: FileChange[] | null }> {
  if (args.mode === "files") {
    const client = getAIClient();
    const authored = await authorFileChanges(
      { prompt: args.prompt, executorProviderPin: args.executorProviderPin, feature: "ai-code-pipeline-author-files", tier: args.tier },
      { complete: (r) => client.complete(r) },
    );
    const ev: ExecutorEvidence = { author: authored.author, provider: authored.provider, costUsd: authored.costUsd, latencyMs: authored.latencyMs, inputTokens: authored.inputTokens ?? null, outputTokens: authored.outputTokens ?? null, error: authored.error };
    return { diff: filesToDiff(authored.changes), author: authored.author, executor: ev, changes: authored.changes };
  }
  if (args.diff.trim()) return { diff: args.diff, author: args.authorModel, executor: null, changes: null };
  const client = getAIClient();
  const executor = await authorDiff(
    { prompt: args.prompt, executorProviderPin: args.executorProviderPin, feature: "ai-code-pipeline-author", tier: args.tier },
    { complete: (r) => client.complete(r) },
  );
  const ev: ExecutorEvidence = { author: executor.author, provider: executor.provider, costUsd: executor.costUsd, latencyMs: executor.latencyMs, inputTokens: executor.inputTokens ?? null, outputTokens: executor.outputTokens ?? null, error: executor.error };
  return { diff: executor.diff, author: executor.author, executor: ev, changes: null };
}

type ResolveArgs = Parameters<typeof resolveChange>[0];

/**
 * Author with a GOVERNED fallback so a simple authoring failure does not end the
 * run. If the first executor produces nothing usable (and no manual diff was
 * supplied), retry once at an escalated tier - a stronger model gets a usable
 * draft to the SAME gate. Only after the fallback still produces nothing does the
 * run surface a 422. The agent keeps the workflow running; the gate still governs
 * whatever it drafts, so this never weakens a check, it only avoids a dead end.
 */
async function resolveChangeWithFallback(
  args: ResolveArgs,
): Promise<Awaited<ReturnType<typeof resolveChange>> & { executorAttempts: number }> {
  const emptyOrError = (r: Awaited<ReturnType<typeof resolveChange>>) => !r.diff.trim() || Boolean(r.executor?.error);
  let resolved = await resolveChange(args);
  let attempts = 1;
  const manualDiff = args.diff.trim().length > 0;
  if (!manualDiff && emptyOrError(resolved)) {
    const retry = await resolveChange({ ...args, tier: "premium" });
    attempts++;
    resolved = retry; // the escalated attempt is the final draft (its evidence is what a human sees if it too failed)
  }
  return { ...resolved, executorAttempts: attempts };
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as {
    ref?: unknown;
    prompt?: unknown;
    answers?: unknown;
    diff?: unknown;
    author?: unknown;
    authorModel?: unknown;
    executorProviderPin?: unknown;
    repo?: unknown;
    mode?: unknown;
    maxAttempts?: unknown;
  };
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const prompt = typeof b.prompt === "string" ? b.prompt : "";
  const diff = typeof b.diff === "string" ? b.diff : "";
  if (!ref) return NextResponse.json({ error: "ref is required" }, { status: 400 });
  if (!prompt.trim()) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  // Optional target repo. Validate the owner/repo shape up front so a malformed
  // value is a clean 400, never a string interpolated into a GitHub API path.
  // Absent -> the executor defaults to apex (self-hosting).
  const repoRaw = typeof b.repo === "string" ? b.repo.trim() : "";
  if (repoRaw && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repoRaw)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }
  const repo = repoRaw || undefined;
  // diff is OPTIONAL: when absent, the EXECUTOR stage authors it from the prompt
  // (input-to-output). A manually supplied diff is still governed as before. The
  // size ceiling is enforced ONCE, unconditionally, on the final diff below - it
  // is never gated by a user-controlled branch.

  // Answers are a flat questionId -> optionId map. The property NAME is
  // allowlisted to the fixed question set - never write a user-named property
  // (remote property injection). The option VALUE is validated by resolveIntake,
  // which rejects an off-menu value as a 400.
  const answers: Record<string, string> = {};
  if (b.answers && typeof b.answers === "object") {
    for (const [k, v] of Object.entries(b.answers as Record<string, unknown>)) {
      if (SPEC_QUESTION_IDS.has(k) && typeof v === "string") answers[k] = v;
    }
  }

  const author = typeof b.author === "string" && b.author.trim() ? b.author.trim() : "unknown";
  const authorModel = typeof b.authorModel === "string" && b.authorModel.trim() ? b.authorModel.trim() : author;
  const maxAttempts =
    typeof b.maxAttempts === "number" && Number.isFinite(b.maxAttempts)
      ? Math.max(1, Math.min(MAX_ATTEMPTS_CAP, Math.floor(b.maxAttempts)))
      : 2;

  const workspaceId = auth.user.workspaceId ?? "default";

  // EXECUTOR stage. No diff supplied -> a model authors it from the prompt, and
  // the authoring model becomes the pipeline `author` so the repairer is a
  // different lineage. Fail-closed: no diff authored -> 422 with the executor
  // evidence, never a 500 and never a fabricated diff.
  const executorProviderPin =
    typeof b.executorProviderPin === "string" && b.executorProviderPin.trim() ? b.executorProviderPin.trim() : undefined;
  const mode: "diff" | "files" = b.mode === "files" ? "files" : "diff";

  // Repo-aware context: when a target repo is set, fetch the current contents of
  // the files the prompt NAMES and prepend them so the executor MODIFIES existing
  // code consistently instead of authoring blind. Best-effort: any failure falls
  // back to prompt-only authoring (no regression). Skipped when a diff is supplied
  // (that is governed as-is). Uses the `repo` already validated above.
  let authorPrompt = prompt;
  let repoContextFiles: string[] = [];
  if (repo && !diff.trim()) {
    try {
      const ghClient = await workspaceGithubClient(workspaceId);
      if (ghClient.token) {
        const ctx = await buildRepoContext({ client: ghClient, repo, prompt });
        authorPrompt = withRepoContext(prompt, ctx.block);
        repoContextFiles = ctx.files;
      }
    } catch {
      /* best-effort context; author from the prompt alone on any failure */
    }
  }

  const resolved = await resolveChangeWithFallback({ mode, diff, prompt: authorPrompt, authorModel, executorProviderPin });
  const executorAttempts = resolved.executorAttempts;
  const executor = resolved.executor;
  let effectiveDiff = resolved.diff;
  let effectiveAuthor = resolved.author;
  let changes = resolved.changes;
  // Fail-closed: the executor ran but produced nothing usable. Never a 500, and
  // never a fabricated change - the gate has nothing to govern.
  if (executor && !effectiveDiff.trim()) {
    return NextResponse.json({ error: "executor produced no change", executor }, { status: 422 });
  }

  // Files-native AUTO-FIX: in files mode, if the authored files do not clear the
  // combined gate, re-author the whole files with the gate's feedback (routed to a
  // DIFFERENT lineage), bounded, until they pass or a human is needed. This is the
  // gate-level half of the auto-fix loop; the CI-level half runs post-PR.
  let filesRepairStatus: "clean" | "needs_human" | "n/a" = "n/a";
  if (mode === "files" && changes && changes.length > 0) {
    const client = getAIClient();
    const indep = chooseIndependentJudge(
      { provider: executor?.provider ?? "", model: effectiveAuthor },
      judgeCandidates(buildRegistry(), "cheap"),
    ).candidate?.provider;
    const repaired = await remediateFileChanges({
      initial: changes,
      initialAuthor: effectiveAuthor,
      reauthor: (feedback) =>
        authorFileChanges(
          { prompt: `${prompt}\n\nThe previous attempt was rejected. ${feedback}`, executorProviderPin: indep, feature: "ai-code-pipeline-repair-files" },
          { complete: (r) => client.complete(r) },
        ),
      maxAttempts: 2,
    });
    changes = repaired.changes;
    effectiveAuthor = repaired.author;
    effectiveDiff = filesToDiff(changes);
    filesRepairStatus = repaired.status;
  }

  // Unconditional ceiling on the final diff, whatever its source (supplied or
  // authored). Enforced on every path, so no user-controlled input decides
  // whether this check runs.
  if (effectiveDiff.length > MAX_DIFF) return NextResponse.json({ error: "diff too large" }, { status: 400 });

  const review = async (d: string): Promise<CodeReviewResult> =>
    runCodeReview({ workspaceId, ref, author: effectiveAuthor, diff: d, nowIso: new Date().toISOString() });

  let run;
  try {
    run = await runPipeline({
      ref,
      prompt,
      answers,
      diff: effectiveDiff,
      author: effectiveAuthor,
      nowIso: new Date().toISOString(),
      review,
      repair: liveRepairComplete(),
      maxAttempts,
    });
  } catch (err) {
    // The only expected throw is an off-menu intake answer (fixed answer space).
    return NextResponse.json({ error: (err as Error).message }, { status: 400 });
  }

  // Deterministic engineering invariants over the FINAL diff, decided by the
  // OGIAM registry (deploy-once, dependency-as-last-resort; CI-complete applies
  // at the merge point, not authoring, so it is not asserted here). This runs
  // alongside the security gate: a change is only handed off when BOTH the
  // security gate allows AND no invariant would block.
  // In files mode the dependency delta is not derivable from a synthesized full
  // file (it shows every dep as "added"), so skip that signal; it stays exact in
  // diff mode. All other invariants apply in both modes.
  const { decision: invariants, facts: changeFacts } = evaluateChangeInvariants(run.diff, { skipDependency: changes != null });

  // Full-power deep static scan: run the platform-scan detector engine (provider-
  // signature secrets, taint/SSRF/SQLi) on the authored files, not just the ai-code
  // subset. A critical finding withholds the handoff, same as an invariant block.
  const deepScan = await deepScanChange(run.diff, repo);

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.pipeline_run",
    resourceType: "ai_code_pipeline_run",
    resourceId: `${workspaceId}:${ref}`,
    afterState: {
      spec_hash: run.spec.hash,
      status: run.status,
      attempts: run.remediation.attempts.length,
      final_outcome: run.review.verdict.outcome,
      open_questions: run.openQuestions.length,
      conforms: run.conformance.conforms,
      author: effectiveAuthor,
      executed: Boolean(executor),
      invariant_rule: invariants.ruleId,
      invariant_outcome: invariants.intendedOutcome,
      dependency_delta: changeFacts.dependencyDelta,
      deep_scan_critical: deepScan.critical,
      deep_scan_high: deepScan.high,
    },
  });

  trackEvent("ai_code.pipeline_run", auth.user.id, auth.user.role, {
    // workspace_id scopes the run history + grading read (multi-tenant safe).
    workspace_id: workspaceId,
    ref,
    spec_hash: run.spec.hash,
    status: run.status,
    attempts: run.remediation.attempts.length,
    final_outcome: run.review.verdict.outcome,
    open_questions: run.openQuestions.length,
    conforms: run.conformance.conforms,
    // Attribution for grading + per-model drift (src/lib/ai-code/grading.ts).
    model: effectiveAuthor,
    cost_usd: executor?.costUsd ?? 0,
    executor_attempts: executorAttempts,
    repo_context_files: repoContextFiles.length,
    deep_scan_critical: deepScan.critical,
  });

  // Protection evidence: one finding_detected per issue the gate caught, so the
  // "protected you from production issues" panel can show what class of problem
  // was stopped (secrets, injection, unsafe patterns) before it reached a human.
  // Workspace-scoped and capped. This is the same event the /review route emits.
  for (const f of run.review.findings.slice(0, 25)) {
    trackEvent("ai_code.finding_detected", auth.user.id, auth.user.role, {
      workspace_id: workspaceId,
      class: f.klass,
      severity: f.severity,
      cwe: f.cwe ?? "none",
    });
  }

  // Fail-closed handoff. A ready-for-PR run captures a PENDING APPROVAL - it does
  // NOT open a PR. A human opens the PR by approving this, through the existing
  // agent-approvals surface. A needs_human run has nothing to hand off. Capturing
  // is best-effort (null without a database); the run is returned either way.
  // Files mode hands off when the files-native repair cleared the change (its final
  // files pass the gate). needs_human means the auto-fix could not clear it after
  // its bounded attempts. Diff mode is unaffected.
  const filesModeHandoffOk = mode !== "files" || filesRepairStatus === "clean";

  let approvalId: string | null = null;
  if (run.status === "ready_for_pr" && !invariants.wouldBlock && !deepScan.blocking && filesModeHandoffOk) {
    approvalId = await createPendingApproval({
      workspaceId,
      agentId: CODE_GATE_AGENT_ID,
      ownerUserId: auth.user.id,
      tool: "ai_code.open_pr",
      params: {
        ref,
        prompt,
        // Target repo for the PR; the executor defaults to apex (self-hosting)
        // when absent. Not user-secret; a human sees exactly what they approve.
        repo,
        spec_hash: run.spec.hash,
        conforms: run.conformance.conforms,
        // The gate ALLOWED this change, so it carries no secret to store; a human
        // sees exactly what they are approving. In files mode the commit uses the
        // full-file changes; in diff mode it uses the diff's new files.
        diff: run.diff,
        ...(changes ? { changes } : {}),
      },
      capability: "settings.manage_team",
    });
  }

  // Cost meter: what the run cost + what the same tokens would cost on other
  // popular models (reuses the router's pricing registry). Iteration overhead
  // (repair attempts) is the measurable hidden cost of a cheaper model.
  const cost = buildRunCost({
    actualUsd: executor?.costUsd ?? null,
    inputTokens: executor?.inputTokens ?? null,
    outputTokens: executor?.outputTokens ?? null,
    repairAttempts: run.remediation.attempts.length,
  });

  return NextResponse.json({ run, approvalId, executor, invariants, changeFacts, deepScan, mode, executorAttempts, repoContext: { files: repoContextFiles }, cost });
}

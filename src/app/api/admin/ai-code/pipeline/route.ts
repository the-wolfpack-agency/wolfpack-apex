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
import { authorDiff, type AuthorResult } from "@/lib/ai-code/author";
import { getAIClient } from "@/lib/ai";
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
    maxAttempts?: unknown;
  };
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const prompt = typeof b.prompt === "string" ? b.prompt : "";
  const diff = typeof b.diff === "string" ? b.diff : "";
  if (!ref) return NextResponse.json({ error: "ref is required" }, { status: 400 });
  if (!prompt.trim()) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
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
  let effectiveDiff = diff;
  let effectiveAuthor = authorModel;
  let executor: AuthorResult | null = null;
  if (!effectiveDiff.trim()) {
    const client = getAIClient();
    executor = await authorDiff(
      { prompt, executorProviderPin, feature: "ai-code-pipeline-author" },
      { complete: (r) => client.complete(r) },
    );
    effectiveDiff = executor.diff;
    effectiveAuthor = executor.author;
    if (!effectiveDiff.trim()) {
      return NextResponse.json({ error: "executor produced no diff", executor }, { status: 422 });
    }
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
    },
  });

  trackEvent("ai_code.pipeline_run", auth.user.id, auth.user.role, {
    ref,
    spec_hash: run.spec.hash,
    status: run.status,
    attempts: run.remediation.attempts.length,
    final_outcome: run.review.verdict.outcome,
    open_questions: run.openQuestions.length,
    conforms: run.conformance.conforms,
  });

  // Fail-closed handoff. A ready-for-PR run captures a PENDING APPROVAL - it does
  // NOT open a PR. A human opens the PR by approving this, through the existing
  // agent-approvals surface. A needs_human run has nothing to hand off. Capturing
  // is best-effort (null without a database); the run is returned either way.
  let approvalId: string | null = null;
  if (run.status === "ready_for_pr") {
    approvalId = await createPendingApproval({
      workspaceId,
      agentId: CODE_GATE_AGENT_ID,
      ownerUserId: auth.user.id,
      tool: "ai_code.open_pr",
      params: {
        ref,
        spec_hash: run.spec.hash,
        conforms: run.conformance.conforms,
        // The gate ALLOWED this diff, so it carries no secret to store; a human
        // sees exactly what they are approving.
        diff: run.diff,
      },
      capability: "settings.manage_team",
    });
  }

  return NextResponse.json({ run, approvalId, executor });
}

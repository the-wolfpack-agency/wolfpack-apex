/**
 * /api/admin/ai-code/pipeline — one governed run over an AI-authored change.
 *
 *   POST { ref, prompt, answers?, diff, author, authorModel, maxAttempts? }
 *        -> intake (fixed multiple-choice -> frozen spec) -> the deterministic
 *           gate -> Stage 2 re-route repair on a non-allow verdict. Returns a run
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
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { runCodeReview } from "@/lib/ai-code/scan";
import { liveRepairComplete } from "@/lib/ai-code/repair";
import { runPipeline } from "@/lib/ai-code/pipeline";
import type { CodeReviewResult } from "@/lib/ai-code/types";

const MAX_DIFF = 2_000_000; // chars
const MAX_ATTEMPTS_CAP = 4;

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

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
    maxAttempts?: unknown;
  };
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const prompt = typeof b.prompt === "string" ? b.prompt : "";
  const diff = typeof b.diff === "string" ? b.diff : "";
  if (!ref) return NextResponse.json({ error: "ref is required" }, { status: 400 });
  if (!prompt.trim()) return NextResponse.json({ error: "prompt is required" }, { status: 400 });
  if (!diff.trim()) return NextResponse.json({ error: "diff is required" }, { status: 400 });
  if (diff.length > MAX_DIFF) return NextResponse.json({ error: "diff too large" }, { status: 400 });

  // Answers are a flat questionId -> optionId map; anything else is ignored, and
  // an off-menu VALUE is rejected below by resolveIntake as a 400.
  const answers: Record<string, string> = {};
  if (b.answers && typeof b.answers === "object") {
    for (const [k, v] of Object.entries(b.answers as Record<string, unknown>)) {
      if (typeof v === "string") answers[k] = v;
    }
  }

  const author = typeof b.author === "string" && b.author.trim() ? b.author.trim() : "unknown";
  const authorModel = typeof b.authorModel === "string" && b.authorModel.trim() ? b.authorModel.trim() : author;
  const maxAttempts =
    typeof b.maxAttempts === "number" && Number.isFinite(b.maxAttempts)
      ? Math.max(1, Math.min(MAX_ATTEMPTS_CAP, Math.floor(b.maxAttempts)))
      : 2;

  const workspaceId = auth.user.workspaceId ?? "default";
  const review = async (d: string): Promise<CodeReviewResult> =>
    runCodeReview({ workspaceId, ref, author, diff: d, nowIso: new Date().toISOString() });

  let run;
  try {
    run = await runPipeline({
      ref,
      prompt,
      answers,
      diff,
      author: authorModel,
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
      author,
    },
  });

  trackEvent("ai_code.pipeline_run", auth.user.id, auth.user.role, {
    ref,
    spec_hash: run.spec.hash,
    status: run.status,
    attempts: run.remediation.attempts.length,
    final_outcome: run.review.verdict.outcome,
    open_questions: run.openQuestions.length,
  });

  return NextResponse.json({ run });
}

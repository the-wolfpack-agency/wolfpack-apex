/**
 * /api/admin/ai-code/remediate — Stage 2: re-route a FAILED diff, hand back a
 * clean rewrite or the still-failing one, honestly labeled.
 *
 *   POST { ref, author, authorModel, diff, maxAttempts? }
 *        -> runs the bounded re-route repair loop:
 *           - the deterministic gate reviews the diff (reusing runCodeReview, so
 *             every attempt is persisted for the audit + learning loop);
 *           - if it does not pass, a model of a DIFFERENT lineage than the author
 *             rewrites it, and the SAME gate re-checks the rewrite - the model
 *             never certifies its own work;
 *           - status "clean" returns a gate-passing diff a HUMAN then opens as a
 *             PR (this route never merges); "needs_human" returns the last diff
 *             with the findings still on it.
 *
 * Capability: settings.manage_team. Hash-chain AUDITED (a remediation is a
 * governance action) and emits ai_code.remediated for the learning loop.
 *
 * Returns: 200 { result } | 400 (bad body) | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { runCodeReview } from "@/lib/ai-code/scan";
import { remediateDiff, liveRepairComplete } from "@/lib/ai-code/repair";
import type { CodeReviewResult } from "@/lib/ai-code/types";

const MAX_DIFF = 2_000_000; // chars
const MAX_ATTEMPTS_CAP = 4; // a hard ceiling on model calls per request

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
    author?: unknown;
    authorModel?: unknown;
    diff?: unknown;
    maxAttempts?: unknown;
  };
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const diff = typeof b.diff === "string" ? b.diff : "";
  if (!ref) return NextResponse.json({ error: "ref is required" }, { status: 400 });
  if (!diff.trim()) return NextResponse.json({ error: "diff is required" }, { status: 400 });
  if (diff.length > MAX_DIFF) return NextResponse.json({ error: "diff too large" }, { status: 400 });

  const author = typeof b.author === "string" && b.author.trim() ? b.author.trim() : "unknown";
  // The model that WROTE the diff drives lineage independence for the repairer.
  const authorModel = typeof b.authorModel === "string" && b.authorModel.trim() ? b.authorModel.trim() : author;
  const maxAttempts =
    typeof b.maxAttempts === "number" && Number.isFinite(b.maxAttempts)
      ? Math.max(1, Math.min(MAX_ATTEMPTS_CAP, Math.floor(b.maxAttempts)))
      : 2;

  const workspaceId = auth.user.workspaceId ?? "default";
  // The reviewer is the shipped gate (runCodeReview): every attempt is scanned,
  // gated deterministically, and persisted. The judge is not run here - the
  // deterministic gate, not a model, decides whether a repair worked.
  const review = async (d: string): Promise<CodeReviewResult> =>
    runCodeReview({ workspaceId, ref, author, diff: d, nowIso: new Date().toISOString() });

  const result = await remediateDiff({
    author: authorModel,
    diff,
    review,
    repair: liveRepairComplete(),
    maxAttempts,
  });

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.remediated",
    resourceType: "ai_code_remediation",
    resourceId: `${workspaceId}:${ref}`,
    afterState: {
      status: result.status,
      attempts: result.attempts.length,
      final_outcome: result.review.verdict.outcome,
      repairer_lineage: result.repairerLineage ?? "none",
      author,
    },
  });

  trackEvent("ai_code.remediated", auth.user.id, auth.user.role, {
    ref,
    status: result.status,
    attempts: result.attempts.length,
    final_outcome: result.review.verdict.outcome,
    repairer_lineage: result.repairerLineage ?? "none",
  });

  return NextResponse.json({ result });
}

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { promoteChange } from "@/lib/deploy/release-gate";

/**
 * POST /api/admin/deployment/release-gate/promote -> promote a ready change to
 * production from inside the product. Body: { prNumber }.
 *
 * Capability: `deploy.promote` - a dedicated, privileged capability (NOT the
 * read capability) because pushing to production is irreversible. Gated to
 * deploy-owning roles (CTO, dev); CEO/EVP can SEE the gate but cannot promote.
 *
 * FAIL CLOSED: `promoteChange` re-fetches the PR and merges ONLY when it is
 * genuinely ready (mergeable + green checks). A not-ready change returns a typed
 * `{ ok:false, reason }` which we translate to HTTP 400 with NO merge performed.
 * We only audit + return 200 on a real merge.
 *
 * Mirrors the admin mutation idiom: capability gate -> run the lib -> on success
 * recordAudit (hash-chained, security-relevant) + trackEvent -> serialize.
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "deploy.promote");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: { prNumber?: unknown };
  try {
    body = (await req.json()) as { prNumber?: unknown };
  } catch {
    return NextResponse.json({ ok: false, reason: "Request body must be JSON." }, { status: 400 });
  }

  const prNumber =
    typeof body.prNumber === "number"
      ? body.prNumber
      : typeof body.prNumber === "string" && /^\d+$/.test(body.prNumber)
        ? Number(body.prNumber)
        : NaN;
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return NextResponse.json(
      { ok: false, reason: "prNumber is required and must be a positive integer." },
      { status: 400 },
    );
  }

  const result = await promoteChange(prNumber);

  if (!result.ok) {
    // Fail-closed path: the change was not ready (or could not be verified), and
    // NO merge happened. 400 + the plain-language reason. We deliberately do NOT
    // audit a refusal here - nothing changed in production.
    return NextResponse.json({ ok: false, reason: result.reason }, { status: 400 });
  }

  // Real promotion happened: a commit is now on the production branch. This is a
  // security-relevant, irreversible admin action -> hash-chained audit entry
  // (who promoted which change to which SHA). Best-effort; an audit write
  // failure must not pretend the merge did not happen.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "deploy.production_promoted",
    resourceType: "deployment",
    resourceId: String(prNumber),
    afterState: { prNumber, mergedSha: result.mergedSha },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[release-gate promote audit]", (e as Error).message));

  // Analytics: there is no dedicated "promoted" event in InstinctEventType and
  // this stream does not own analytics.ts, so we record the promotion against the
  // gate's registered event with a blocking_count of 0 (this change no longer
  // blocks) plus the promoted PR. The hash-chained audit entry above is the
  // durable system-of-record for the promotion itself.
  trackEvent("deploy.release_gate_viewed", user.id, user.role, {
    blocking_count: 0,
    promoted_pr: prNumber,
    merged_sha: result.mergedSha,
  });

  return NextResponse.json({ ok: true, mergedSha: result.mergedSha });
}

/**
 * /api/admin/ai-code/review — gate an AI-authored diff before it merges.
 *
 *   POST { ref, author, diff }  -> scan the diff, return the verdict + findings,
 *                                  persist the review, audit + analytics.
 *   GET                          -> recent review history for the workspace.
 *
 * The verdict is a deterministic gate decision (allow / escalate / block) over
 * CWE-classified findings in the ADDED lines - models propose code, policy
 * decides whether it merges. Capability: settings.manage_team. The verdict is a
 * security-relevant governance decision, so it is hash-chain AUDITED, and emits
 * ai_code.reviewed + one ai_code.finding_detected per finding for the learning loop.
 *
 * Returns: 200 { result } | 400 (bad body) | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { runCodeReview } from "@/lib/ai-code/scan";
import { listReviews } from "@/lib/ai-code/store";

const MAX_DIFF = 2_000_000; // chars
const MAX_FINDING_EVENTS = 100;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const reviews = await listReviews(auth.user.workspaceId ?? "default");
  return NextResponse.json({ reviews });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { ref?: unknown; author?: unknown; diff?: unknown };
  const ref = typeof b.ref === "string" ? b.ref.trim() : "";
  const diff = typeof b.diff === "string" ? b.diff : "";
  if (!ref) return NextResponse.json({ error: "ref is required" }, { status: 400 });
  if (!diff.trim()) return NextResponse.json({ error: "diff is required" }, { status: 400 });
  if (diff.length > MAX_DIFF) return NextResponse.json({ error: "diff too large" }, { status: 400 });
  const author = typeof b.author === "string" && b.author.trim() ? b.author.trim() : "unknown";

  const workspaceId = auth.user.workspaceId ?? "default";
  const result = await runCodeReview({ workspaceId, ref, author, diff, nowIso: new Date().toISOString() });

  // The gate verdict gates a merge: hash-chain it.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ai_code.reviewed",
    resourceType: "ai_code_review",
    resourceId: `${workspaceId}:${ref}`,
    afterState: {
      outcome: result.verdict.outcome,
      highest_severity: result.verdict.highestSeverity,
      finding_count: result.findings.length,
      author,
    },
  });

  trackEvent("ai_code.reviewed", auth.user.id, auth.user.role, {
    ref,
    author,
    outcome: result.verdict.outcome,
    findings: result.findings.length,
    highest_severity: result.verdict.highestSeverity,
  });
  for (const f of result.findings.slice(0, MAX_FINDING_EVENTS)) {
    trackEvent("ai_code.finding_detected", auth.user.id, auth.user.role, {
      class: f.klass,
      severity: f.severity,
      cwe: f.cwe ?? "none",
    });
  }

  return NextResponse.json({ result });
}

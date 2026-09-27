/**
 * GET /api/admin/ai-code/readiness?repo=<owner/name>
 *
 * The onboarding preflight: runs every environmental check ONCE, up front, so a
 * user never trips over a surprise mid-flow. Reports a single green / amber / red
 * readiness with a one-click fix per blocker (GitHub access, repo access,
 * automatic PRs, CI presence, baseline health).
 *
 * Read-only. Capability + secure_agent entitlement gated. Never 500s: an
 * unreachable repo becomes a not-ready report with the reason.
 * Returns: 200 { readiness } | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { assessReadiness } from "@/lib/ai-code/readiness";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const repo = (new URL(req.url).searchParams.get("repo") ?? "").trim();
  if (!repo) return NextResponse.json({ error: "repo is required" }, { status: 400 });
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }

  const readiness = await assessReadiness(
    repo,
    auth.user.workspaceId ?? undefined,
    process.env.NEXT_PUBLIC_GITHUB_APP_INSTALL_URL || undefined,
  );
  return NextResponse.json({ readiness });
}

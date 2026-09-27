/**
 * GET /api/admin/ai-code/ci?repo=<owner/name>&ref=<branch|sha>
 *
 * The pipeline-health dashboard read: the CI check runs for a ref, rolled into
 * high-level, product-agnostic checkpoints (Unit tests, Code quality, Security,
 * Build & deploy, ...). A non-technical user reads "is my code healthy" without
 * ever seeing which tool produced each check.
 *
 * Read-only. Capability + secure_agent entitlement gated. Never 500s: an
 * unreadable pipeline is an all-absent dashboard, not an error.
 * Returns: 200 { dashboard } | 400 | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { fetchCiDashboard } from "@/lib/ai-code/ci-status";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const url = new URL(req.url);
  const repo = (url.searchParams.get("repo") ?? "").trim();
  const ref = (url.searchParams.get("ref") ?? "").trim();
  if (!repo || !ref) return NextResponse.json({ error: "repo and ref are required" }, { status: 400 });
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
    return NextResponse.json({ error: "repo must be in owner/name form" }, { status: 400 });
  }

  const dashboard = await fetchCiDashboard(repo, ref, auth.user.workspaceId ?? undefined);
  return NextResponse.json({ dashboard });
}

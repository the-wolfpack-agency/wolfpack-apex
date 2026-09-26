/**
 * GET /api/admin/ai-code/ci-status?repo=<owner/name>&ref=<branch|sha>
 *
 * Reads a factory PR's CI status back into Instinct: the check-run summary for
 * the head ref, including whether CI has FULLY passed (ciComplete, the producer
 * for the OGIAM CI invariant). Read-only. Capability + entitlement gated.
 *
 * Returns: 200 { summary } | 400 (missing repo/ref) | 401/403 (auth/entitlement)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { fetchCiStatus } from "@/lib/ai-code/ci-status";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const url = new URL(req.url);
  const repo = (url.searchParams.get("repo") ?? "").trim();
  const ref = (url.searchParams.get("ref") ?? "").trim();
  if (!repo || !ref) return NextResponse.json({ error: "repo and ref are required" }, { status: 400 });

  const summary = await fetchCiStatus(repo, ref, auth.user.workspaceId ?? undefined);
  return NextResponse.json({ summary });
}

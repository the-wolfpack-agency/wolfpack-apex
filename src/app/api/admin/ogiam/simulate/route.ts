/**
 * POST /api/admin/ogiam/simulate — dry-run a candidate enforcement posture.
 *
 * Replays a candidate enforce-set over the recorded ogiam_decisions ledger and
 * returns the blast radius (how many actions it would NEWLY block, by capability
 * / agent / outcome) WITHOUT enforcing or executing anything. The control-plane
 * equivalent of testing a firewall rule against real traffic before applying it.
 *
 * Capability: settings.manage_team (same gate as the OGIAM decisions explorer).
 * Read-only. Emits ogiam.policy_simulated so the learning loop sees that the
 * shadow ledger is being used as a decision-support asset.
 *
 * Returns: 200 { report } | 400 (bad body) | 401/403 (auth, via requireCapability)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { runEnforcementSimulation } from "@/lib/ogiam/simulate";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { enforceCapabilities?: unknown; windowDays?: unknown };
  const caps = Array.isArray(b.enforceCapabilities)
    ? b.enforceCapabilities.filter((c): c is string => typeof c === "string" && c.trim().length > 0)
    : [];
  if (caps.length === 0) {
    return NextResponse.json(
      { error: "enforceCapabilities must be a non-empty array of capability strings" },
      { status: 400 },
    );
  }
  const windowDays = typeof b.windowDays === "number" ? b.windowDays : 30;

  const workspaceId = auth.user.workspaceId ?? "default";
  const report = await runEnforcementSimulation(workspaceId, { enforceCapabilities: caps }, windowDays);

  trackEvent("ogiam.policy_simulated", auth.user.id, auth.user.role, {
    window_days: report.windowDays,
    decisions: report.decisions,
    candidate_capabilities: report.candidateCapabilities.length,
    newly_blocked: report.newlyBlocked,
    currently_blocked: report.currentlyBlocked,
  });

  return NextResponse.json({ report });
}

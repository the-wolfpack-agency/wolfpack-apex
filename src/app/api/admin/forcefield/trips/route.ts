/**
 * GET /api/admin/forcefield/trips - the canary trips for the workspace.
 *
 * Read-only triage: the decoy touches that tripped containment (each an agent
 * that got revoked, recorded in the OGIAM ledger). Reuses listCanaryTrips, which
 * reads the ledger through its own query path. No decoy value is ever in the
 * ledger, so nothing sensitive is exposed here. Capability: settings.manage_team.
 *
 * Returns: 200 { trips } | 401/403 (auth).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { listCanaryTrips } from "@/lib/forcefield/triage";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "forcefield");
  if (gate) return gate;
  const trips = await listCanaryTrips(auth.user.workspaceId ?? "default");
  return NextResponse.json({ trips });
}

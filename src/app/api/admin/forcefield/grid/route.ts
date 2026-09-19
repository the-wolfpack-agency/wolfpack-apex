/**
 * POST /api/admin/forcefield/grid - seed a DIVERSE deception grid: ensure one
 * active decoy of each kind (token, route, row, tool) exists, so coverage is
 * never accidentally thin. Idempotent (only seeds missing kinds). Seeding a
 * decoy is a security-relevant control change, so it is capability-gated,
 * entitlement-gated, and hash-chain AUDITED. The per-canary forcefield.canary_seeded
 * analytics fires in the store; this adds one audit entry for the grid action.
 * Decoy VALUES are never audited or returned - only kinds + placement labels.
 *
 * Returns: 200 { result } | 401/403 (auth/entitlement).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { recordAudit } from "@/lib/audit-log";
import { ensureDeceptionGrid } from "@/lib/forcefield/deception-grid";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "forcefield");
  if (gate) return gate;

  const workspaceId = auth.user.workspaceId ?? "default";
  const result = await ensureDeceptionGrid({ workspaceId, createdBy: auth.user.id });

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.grid_seeded",
    resourceType: "forcefield_grid",
    resourceId: workspaceId,
    afterState: {
      seeded_kinds: result.seeded.map((s) => s.kind),
      already_present: result.alreadyPresent,
    },
  });

  return NextResponse.json({ result });
}

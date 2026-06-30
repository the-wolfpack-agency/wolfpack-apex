/**
 * /api/admin/ogiam/demo-reset - one-click demo seed.
 *
 *   POST -> restore a known-good, populated governance state across all five
 *           demo beats (Discover / Govern / Assure / Comply), seeded through the
 *           REAL domain path (gate -> tamper-evident ledger, inventory upsert,
 *           red-team executor, compliance orchestrator). Nothing is injected at
 *           the DB layer, so the demo data is honest, audited, triple-written,
 *           and feeds the learning loop exactly as live client traffic would.
 *
 * Idempotent-safe to re-run before a demo. Mutates control-plane state, so the
 * seed itself is hash-chained to the audit log (who restored the demo, what it
 * produced) and emits ogiam.demo_seeded. Capability: settings.manage_team.
 *
 * Returns: 200 { result } | 401/403 (auth)
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { seedGovernanceDemo } from "@/lib/ogiam/demo-seed";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const workspaceId = auth.user.workspaceId ?? "default";
  const result = await seedGovernanceDemo({
    workspaceId,
    actorId: auth.user.id,
    actorRole: auth.user.role,
    nowIso: new Date().toISOString(),
  });

  // Restoring the demo touches the control plane (enforcement postures + the
  // decision ledger): hash-chain it so the audit trail shows who reset the demo
  // and what it produced.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "ogiam.demo.seeded",
    resourceType: "ogiam_demo",
    resourceId: `${workspaceId}:${result.target}`,
    afterState: {
      surfaces: result.surfaces.found,
      decisions: result.decisions.recorded,
      would_block: result.decisions.wouldBlock,
      redteam_pass_rate: result.redteam.passRate,
      compliance_reports: result.compliance.length,
    },
  });

  trackEvent("ogiam.demo_seeded", auth.user.id, auth.user.role, {
    surfaces: result.surfaces.found,
    decisions: result.decisions.recorded,
    flagged: result.decisions.flagged,
    would_block: result.decisions.wouldBlock,
    enforce_policies: result.enforcement.filter((e) => e.mode === "enforce").length,
    redteam_pass_rate: result.redteam.passRate,
    compliance_reports: result.compliance.length,
  });

  return NextResponse.json({ result });
}

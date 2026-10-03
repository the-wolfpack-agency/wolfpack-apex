/**
 * GET /api/admin/ai-code/audit?limit=N
 *
 * Verifiable audit evidence: the OGIAM decision ledger for this workspace, plus
 * an INDEPENDENT re-verification of its hash chain. This is the transparency
 * edge - not "trust our dashboard", but a tamper-evident record a client (or
 * their auditor) can download and check: every entry's hash is recomputed from
 * the prior entry's hash + its stored payload, so a single altered row breaks
 * the chain visibly.
 *
 * Reuses verifyChain (the same check the gate self-test runs) and listDecisions,
 * so the export can never diverge from what the system actually enforces.
 * Read-only. Capability + secure_agent entitlement gated.
 * Returns: 200 { verification, entries, entryCount, generatedAtIso } | 401/403
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { resolveWorkspace } from "@/lib/auth/workspace";
import { requireEntitlement } from "@/lib/tenancy/require-entitlement";
import { verifyChain } from "@/lib/ogiam/checkpoint";
import { listDecisions } from "@/lib/ogiam/queries";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const gate = await requireEntitlement(auth.user.workspaceId, "secure_agent");
  if (gate) return gate;

  const workspaceId = resolveWorkspace(auth.user.workspaceId);
  const limParam = Number(new URL(req.url).searchParams.get("limit"));
  const limit = Number.isFinite(limParam) && limParam > 0 ? limParam : 200;

  const verification = await verifyChain(workspaceId);
  const entries = await listDecisions(workspaceId, { limit });

  return NextResponse.json({
    verification,
    entries,
    entryCount: entries.length,
    generatedAtIso: new Date().toISOString(),
  });
}

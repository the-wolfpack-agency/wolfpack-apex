/**
 * GET /api/admin/forcefield/assurance
 *
 * The honest protection posture + the self-attack results for this deployment.
 * Gathers real state (enforcement mode, issuers, decoys, opt-ins, crypto posture),
 * computes the per-control assurance report, and runs the adversarial self-test
 * suite against the REAL defense functions. Read-only. Capability-gated so the
 * posture is not leaked to every seat.
 *
 *   GET -> { assurance, adversarial }
 *   401/403 via requireCapability("settings.manage_team")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { buildAssuranceReport } from "@/lib/forcefield/assurance";
import { runAdversarialSuite } from "@/lib/forcefield/adversarial";
import { runBreachCorpus } from "@/lib/forcefield/breach-corpus";
import { benchmarkLowAndSlow } from "@/lib/forcefield/low-and-slow";
import { getEdgePolicy } from "@/lib/forcefield/edge-policy";
import { listDelegationIssuers } from "@/lib/forcefield/principal";
import { getReputationOptIn } from "@/lib/forcefield/operator-reputation";
import { listCanariesForDisplay } from "@/lib/forcefield/canary-store";
import { listIngestSources, ingestSigningEnforced } from "@/lib/forcefield/ingest-signing";
import { anchorStatus } from "@/lib/forcefield/audit-anchor";
import { buildPqInventory } from "@/lib/crypto/pq-inventory";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  const [policy, issuers, optIn, canaries, ingestSources, anchors] = await Promise.all([
    getEdgePolicy(workspaceId).catch(() => ({ mode: "monitor" as const, autoBlock: false })),
    listDelegationIssuers(workspaceId).catch(() => []),
    getReputationOptIn(workspaceId).catch(() => ({ contribute: false, consume: false })),
    listCanariesForDisplay(workspaceId).catch(() => []),
    listIngestSources().catch(() => []),
    anchorStatus().catch(() => ({ configured: false, count: 0, lastSeq: null })),
  ]);

  const pqInventory = buildPqInventory();
  const assurance = buildAssuranceReport({
    enforceMode: policy.mode,
    autoBlockEnabled: policy.autoBlock,
    delegationIssuers: issuers.length,
    asymmetricIssuers: issuers.filter((i) => i.algorithm === "es256").length,
    decoysSeeded: canaries.length,
    reputationConsume: optIn.consume,
    hybridTlsAsserted: !!process.env.PROD_DOMAIN,
    externalAuditAnchor: anchors.configured && anchors.count > 0,
    ingestSourceSigned: ingestSigningEnforced() && ingestSources.length > 0,
    pqQuantumVulnerable: pqInventory.quantumVulnerable,
    pqSlotImplemented: pqInventory.pqSlotImplemented,
  });

  const [adversarial, breaches] = await Promise.all([runAdversarialSuite(), runBreachCorpus()]);
  const lowAndSlow = benchmarkLowAndSlow();

  return NextResponse.json({ assurance, adversarial, breaches, lowAndSlow });
}

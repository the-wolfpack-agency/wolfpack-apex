/**
 * GET /api/admin/forcefield/assurance
 *
 * The evidence-backed protection posture + the self-attack results for this
 * deployment. Every control status is computed from evidence that it EXECUTED
 * inside a freshness window (windowed event/row counts, the tripwire self-test
 * through the real code, the adversarial scenarios through the real defenses).
 * Configuration is passed for context only and never makes a control "active".
 * Read-only. Capability-gated so the posture is not leaked to every seat.
 *
 *   GET -> { assurance, adversarial, breaches, lowAndSlow }
 *   401/403 via requireCapability("settings.manage_team")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { buildAssuranceReport } from "@/lib/forcefield/assurance";
import { ASSURANCE_SITE, collectAssuranceEvidence } from "@/lib/forcefield/assurance-evidence";
import { runAdversarialSuite } from "@/lib/forcefield/adversarial";
import { runBreachCorpus } from "@/lib/forcefield/breach-corpus";
import { benchmarkLowAndSlow } from "@/lib/forcefield/low-and-slow";
import { getEdgePolicy } from "@/lib/forcefield/edge-policy";
import { listDelegationIssuers } from "@/lib/forcefield/principal";
import { getReputationOptIn } from "@/lib/forcefield/operator-reputation";
import { listIngestSources, ingestSigningEnforced } from "@/lib/forcefield/ingest-signing";
import { buildPqInventory } from "@/lib/crypto/pq-inventory";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  // A config read that fails is null (unknown), never a passing default.
  const [policy, issuers, optIn, ingestSources, evidence, adversarial, breaches] = await Promise.all([
    getEdgePolicy(workspaceId).catch(() => ({ mode: "monitor" as const, autoBlock: false })),
    listDelegationIssuers(workspaceId).catch(() => null),
    getReputationOptIn(workspaceId).catch(() => null),
    listIngestSources().catch(() => null),
    collectAssuranceEvidence(workspaceId),
    runAdversarialSuite(),
    runBreachCorpus(),
  ]);

  const scenario = (id: string): boolean | null => {
    const r = adversarial.results.find((x) => x.id === id);
    return r ? r.defended : null;
  };

  const pqInventory = buildPqInventory();
  const assurance = buildAssuranceReport({
    site: ASSURANCE_SITE,
    enforceMode: policy.mode,
    autoBlockEnabled: policy.autoBlock,
    delegationIssuers: issuers ? issuers.length : null,
    asymmetricIssuers: issuers ? issuers.filter((i) => i.algorithm === "es256").length : null,
    reputationConsume: optIn ? optIn.consume : null,
    ingestSigningEnforced: ingestSigningEnforced(),
    ingestSources: ingestSources ? ingestSources.length : null,
    hybridTlsAssertedInCi: !!process.env.PROD_DOMAIN,
    pqQuantumVulnerable: pqInventory.quantumVulnerable,
    pqSlotImplemented: pqInventory.pqSlotImplemented,
    probes: evidence.probes,
    samples: {
      replay: scenario("replay"),
      injectionAsData: scenario("injection-as-data"),
      tripwire: evidence.tripwire,
    },
  });

  const lowAndSlow = benchmarkLowAndSlow();

  trackEvent("assurance.report_computed", auth.user.id, auth.user.role, {
    active: assurance.activeCount,
    partial: assurance.partialCount,
    gap: assurance.gapCount,
    unknown: assurance.unknownCount,
    total: assurance.total,
    score: assurance.score,
  });

  return NextResponse.json({ assurance, adversarial, breaches, lowAndSlow });
}

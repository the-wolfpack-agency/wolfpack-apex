/**
 * Evidence collector: gather the live, measured signals the compliance engine
 * derives status from. This is the "all data consumed to benefit the system"
 * seam - it reads the existing stores (audit ledger, gate decisions, red-team,
 * AI inventory, enforce posture) and turns them into one EvidenceInputs.
 *
 * Every source is best-effort: a missing store or DB error degrades that signal
 * to its safe default (which the crosswalk reads as a gap/partial), so a cold
 * system reports honest gaps rather than throwing. Never invents evidence.
 */
import { verifyChain } from "@/lib/audit-log";
import { summarizeDecisions } from "@/lib/ogiam/queries";
import { listEnforcementPolicy } from "@/lib/ogiam/enforcement-policy";
import { listRuns } from "@/lib/ai-redteam/store";
import { summarizeSurfaces } from "@/lib/ai-surface/store";
import { getSigner } from "@/lib/ogiam/signing";
import { encryptSecret, decryptSecret } from "@/lib/crypto/secret-storage";
import isolationBaseline from "@/lib/db/__generated__/tenant-isolation-baseline.json";
import type { EvidenceInputs } from "./types";

const RECENT_MS = 7 * 24 * 60 * 60 * 1000;

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}

/**
 * Data-protection posture, MEASURED (never asserted): is a real signer active
 * (so the ledger + evidence exports are independently verifiable), and does
 * at-rest secret encryption actually round-trip. Each probe degrades to its
 * safe-false default on any error, so a misconfigured system reports an honest
 * gap rather than a claim. Pure + synchronous (no DB, no network).
 */
export function cryptoPosture(): {
  signingActive: boolean;
  signingAlgorithm: string;
  secretsEncryptedAtRest: boolean;
} {
  let signingActive = false;
  let signingAlgorithm = "none";
  try {
    const alg = getSigner().algorithm;
    signingAlgorithm = alg;
    signingActive = alg !== "none";
  } catch {
    /* no signer configured -> inactive (honest gap) */
  }

  let secretsEncryptedAtRest = false;
  try {
    const probe = "compliance-evidence-probe";
    const token = encryptSecret(probe);
    secretsEncryptedAtRest = token !== probe && decryptSecret(token) === probe;
  } catch {
    /* encryption unavailable -> not protected (honest gap) */
  }

  return { signingActive, signingAlgorithm, secretsEncryptedAtRest };
}

/**
 * Tenant-isolation posture from the CI-verified guardrail baseline: every
 * workspace-scoped query is classified (0 unclassified) across N scoped tables.
 * Reads the committed baseline the tenant-isolation scan writes; a malformed or
 * missing baseline degrades to not-enforced.
 */
export function isolationPosture(): { tenantIsolationEnforced: boolean; tenantScopedTables: number } {
  const b = isolationBaseline as { unclassifiedCount?: number; scopedTableCount?: number };
  const scoped = typeof b.scopedTableCount === "number" ? b.scopedTableCount : 0;
  return {
    tenantIsolationEnforced: b.unclassifiedCount === 0 && scoped > 0,
    tenantScopedTables: scoped,
  };
}

export async function collectEvidence(workspaceId: string, nowMs = Date.now()): Promise<EvidenceInputs> {
  const [chain, decisions, posture, runs, surfaces] = await Promise.all([
    safe(() => verifyChain(), { valid: false, checkedCount: 0 } as { valid: boolean; checkedCount: number }),
    safe(() => summarizeDecisions(workspaceId), { total: 0, would_block: 0, by_tier: {}, by_outcome: {} }),
    safe(() => listEnforcementPolicy(workspaceId), [] as Array<{ mode: string }>),
    safe(() => listRuns(workspaceId, 1), [] as Array<{ passRate: number; createdAt: string }>),
    safe(() => summarizeSurfaces(workspaceId), { total: 0, ungoverned: 0, byKind: {}, byProvider: {}, byRisk: {} }),
  ]);

  const latest = runs[0];
  const redteamRecent = !!latest && nowMs - new Date(latest.createdAt).getTime() < RECENT_MS;

  const crypto = cryptoPosture();
  const isolation = isolationPosture();

  return {
    auditChainValid: chain.valid && chain.checkedCount > 0,
    auditEntries: chain.checkedCount,
    gateDecisions: decisions.total,
    gateWouldBlock: decisions.would_block,
    enforceCapabilities: posture.filter((p) => p.mode === "enforce").length,
    redteamPassRate: latest ? latest.passRate : null,
    redteamRecent,
    aiSurfacesTotal: surfaces.total,
    ungovernedAiSurfaces: surfaces.ungoverned,
    signingActive: crypto.signingActive,
    signingAlgorithm: crypto.signingAlgorithm,
    secretsEncryptedAtRest: crypto.secretsEncryptedAtRest,
    tenantIsolationEnforced: isolation.tenantIsolationEnforced,
    tenantScopedTables: isolation.tenantScopedTables,
  };
}

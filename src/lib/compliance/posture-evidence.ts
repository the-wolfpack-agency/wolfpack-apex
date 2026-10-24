/**
 * Live facts for the security-posture parity check. Reuses the platform
 * evidence collector (compliance) and the audit-chain probe (Forcefield
 * assurance), so the posture page, the compliance crosswalk and the assurance
 * panel are judged by the same measurements. Read-only; never throws.
 */
import { hasDatabase, query } from "@/lib/db";
import { ACCESS_TOKEN_TTL } from "@/lib/crypto/cookies";
import isolationBaseline from "@/lib/db/__generated__/tenant-isolation-baseline.json";
import { assuranceProbeSpecs } from "@/lib/forcefield/assurance-evidence";
import { runEvidenceProbe, type EvidenceExecutor } from "./evidence-window";
import { collectPlatformEvidence } from "./platform-evidence";
import type { PostureFacts } from "./posture-claims";

/**
 * Attested facts that the running app cannot read. Each names where it is
 * checked; flip it in the same PR that makes it true.
 *  - MFA: src/app/api/auth/mfa/verify/route.ts is NON-ENFORCING; sign-in does
 *    not require a second factor for any role.
 *  - CodeQL: the main branch's required checks are verify, Static Security
 *    Scan, reality-check and verify-platform (gh api .../protection/
 *    required_status_checks, read 2026-10-24); CodeQL runs but is not required.
 */
export const ATTESTED = { mfaEnforced: false, codeqlRequired: false } as const;

function liveExecutor(): EvidenceExecutor | null {
  if (!hasDatabase()) return null;
  return async (sql, params) => query(sql, params);
}

export function guardrailFromBaseline(b: { unclassifiedCount?: number; scopedTableCount?: number } = isolationBaseline as { unclassifiedCount?: number; scopedTableCount?: number }): boolean | null {
  if (typeof b.unclassifiedCount !== "number") return null;
  return b.unclassifiedCount === 0 && (b.scopedTableCount ?? 0) > 0;
}

export async function collectPostureFacts(
  workspaceId: string,
  exec: EvidenceExecutor | null = liveExecutor(),
  nowMs: number = Date.now(),
  env: Record<string, string | undefined> = process.env,
): Promise<PostureFacts> {
  const [platform, chain] = await Promise.all([
    collectPlatformEvidence(workspaceId, exec, nowMs, env).catch(() => null),
    runEvidenceProbe(assuranceProbeSpecs(workspaceId)["audit.chain_verified"], exec, nowMs),
  ]);
  return {
    platform,
    chain,
    isolationGuardrail: guardrailFromBaseline(),
    hybridTlsAssertedInCi: !!env.PROD_DOMAIN,
    accessTokenTtlSeconds: ACCESS_TOKEN_TTL,
    mfaEnforced: ATTESTED.mfaEnforced,
    codeqlRequired: ATTESTED.codeqlRequired,
  };
}

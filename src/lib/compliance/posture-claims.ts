/**
 * Security-posture claims, each tied to the evidence that proves it.
 *
 * docs/security-posture.md (served publicly at /security-posture) carries a
 * "Control status" table. Every row names one claim below by its evidence key
 * and states its status in words. This module is the other half: for each claim
 * it says how the status is PROVEN, from the same measured facts the compliance
 * crosswalk and the Forcefield assurance panel use (one collector, so the three
 * surfaces cannot disagree).
 *
 * The parity rule: a claim the document marks "In place" must not have evidence
 * that reads "gap". A claim whose evidence cannot be measured in this process
 * reads "unknown" and is reported, never silently counted as proof. A fix that is
 * under way is "In progress", never "In place".
 *
 * Pure. The live facts are gathered by collectPostureFacts (posture-evidence.ts)
 * and by the tests from fixtures.
 */
import type { EvidenceProbe } from "./evidence-window";
import type { PlatformEvidence } from "./platform-evidence";

export type ClaimStatus = "in_place" | "in_progress" | "not_in_place";
export type ClaimEvidence = "proven" | "gap" | "unknown";

/** The words the document uses for each status (the parity test maps them). */
export const STATUS_WORDS: Record<ClaimStatus, string> = {
  in_place: "In place",
  in_progress: "In progress",
  not_in_place: "Not in place",
};

/** The measured facts every claim is evaluated against. null = not measured. */
export interface PostureFacts {
  platform: PlatformEvidence | null;
  /** audit.chain_verified probe (the unattended verifier ran and passed). */
  chain: EvidenceProbe | null;
  /** The repo-wide workspace-predicate guardrail baseline reports 0 unclassified. */
  isolationGuardrail: boolean | null;
  /** PROD_DOMAIN is set, so the CI hybrid-TLS handshake assertion runs. */
  hybridTlsAssertedInCi: boolean;
  /** Access-token TTL in seconds, read from the code that sets it. */
  accessTokenTtlSeconds: number;
  /** Admin MFA is enforced at sign-in. Attested in posture-evidence.ts from the
   *  code (mfa/verify is NON-ENFORCING today); flip there when login enforces it. */
  mfaEnforced: boolean;
  /** CodeQL is a REQUIRED status check on main. Attested; branch protection is
   *  not readable from the running app. */
  codeqlRequired: boolean;
}

export interface PostureClaim {
  /** Evidence key; the doc table row carries it in backticks. */
  key: string;
  /** What the claim says. */
  control: string;
  /** The status the document states. */
  docStatus: ClaimStatus;
  /** How the claim is proven from facts. */
  evaluate: (f: PostureFacts) => ClaimEvidence;
  /** What proves it, in words. */
  proof: string;
}

const probeEvidence = (p: EvidenceProbe | null): ClaimEvidence =>
  !p || p.state === "error" ? "unknown" : p.state === "fresh" ? "proven" : "gap";

export const POSTURE_CLAIMS: readonly PostureClaim[] = [
  {
    key: "secrets.oauth_tokens_encrypted",
    control: "Microsoft Graph and QuickBooks OAuth tokens encrypted by the application at rest",
    docStatus: "in_progress",
    proof: "count of stored OAuth access/refresh tokens that are not v1.* ciphertext is 0",
    evaluate: (f) => {
      const t = f.platform?.oauthTokens;
      if (!t) return "unknown";
      return t.plaintext === 0 ? "proven" : "gap";
    },
  },
  {
    key: "secrets.app_encrypted",
    control: "Integration credentials and MFA seeds encrypted by the application at rest under a dedicated key",
    docStatus: "in_progress",
    proof: "no stored connector credential is outside v1.* ciphertext AND the at-rest key is a dedicated INSTINCT_SECRET_KEY (not derived from another secret)",
    evaluate: (f) => {
      const c = f.platform?.connectorCredentials;
      if (!c || !f.platform) return "unknown";
      return c.plaintext === 0 && f.platform.kekSource === "dedicated" ? "proven" : "gap";
    },
  },
  {
    key: "isolation.app_predicate",
    control: "Tenant isolation by a workspace predicate on every workspace-scoped query, enforced by a build-failing guardrail",
    docStatus: "in_place",
    proof: "the tenant-isolation guardrail baseline reports 0 unclassified queries",
    evaluate: (f) => (f.isolationGuardrail === null ? "unknown" : f.isolationGuardrail ? "proven" : "gap"),
  },
  {
    key: "isolation.db_rls",
    control: "Database row-level security enforces tenant isolation",
    docStatus: "not_in_place",
    proof: "policies other than USING(true) exist, RLS is forced, and the app role does not bypass RLS",
    evaluate: (f) => {
      const r = f.platform?.rls;
      if (!r) return "unknown";
      return r.nonTrivialPolicies > 0 && r.forced > 0 && !r.roleBypassesRls ? "proven" : "gap";
    },
  },
  {
    key: "auth.mfa_enforced",
    control: "Multi-factor authentication enforced for administrators",
    docStatus: "not_in_place",
    proof: "sign-in requires a second factor for admin roles",
    evaluate: (f) => (f.mfaEnforced ? "proven" : "gap"),
  },
  {
    key: "auth.short_access_tokens",
    control: "Session access tokens expire after 15 minutes",
    docStatus: "in_place",
    proof: "ACCESS_TOKEN_TTL in src/lib/crypto/cookies.ts is 900 seconds",
    evaluate: (f) => (f.accessTokenTtlSeconds > 0 && f.accessTokenTtlSeconds <= 900 ? "proven" : "gap"),
  },
  {
    key: "audit.hash_chain",
    control: "Append-only, hash-chained audit log, verified on a schedule",
    docStatus: "in_place",
    proof: "an audit.chain_verified event with valid=true in the last day, and the newest verification passed",
    evaluate: (f) => probeEvidence(f.chain),
  },
  {
    key: "signing.ledger_checkpoints",
    control: "Agent-action ledger checkpoints are cryptographically signed",
    docStatus: "not_in_place",
    proof: "ogiam_checkpoints rows with a real algorithm and a signature in the last 7 days",
    evaluate: (f) => probeEvidence(f.platform?.signedCheckpoints ?? null),
  },
  {
    key: "tls.hybrid_kex",
    control: "Data in transit protected by hybrid post-quantum TLS (X25519MLKEM768) where the client supports it",
    docStatus: "in_place",
    proof: "a TLS 1.3 handshake to the production domain negotiates X25519MLKEM768 (the CI check when PROD_DOMAIN is set; the running app cannot observe it)",
    evaluate: (f) => (f.hybridTlsAssertedInCi ? "proven" : "unknown"),
  },
  {
    key: "tls.hybrid_ci_asserted",
    control: "Hybrid post-quantum TLS (X25519MLKEM768) asserted continuously in CI",
    docStatus: "not_in_place",
    proof: "PROD_DOMAIN is set, so the CI handshake check runs",
    evaluate: (f) => (f.hybridTlsAssertedInCi ? "proven" : "gap"),
  },
  {
    key: "ci.codeql_required",
    control: "CodeQL findings fail the build (a required check on main)",
    docStatus: "not_in_place",
    proof: "CodeQL is listed in the main branch's required status checks",
    evaluate: (f) => (f.codeqlRequired ? "proven" : "gap"),
  },
];

export interface ParityResult {
  key: string;
  control: string;
  docStatus: ClaimStatus;
  evidence: ClaimEvidence;
  proof: string;
  /** The document says "In place" but the evidence says gap. */
  violation: boolean;
  /** The document is more modest than the evidence (proven, but not claimed). */
  understated: boolean;
}

export interface ParityReport {
  results: ParityResult[];
  violations: number;
  unknown: number;
  proven: number;
}

/** Evaluate every claim against measured facts. Pure. */
export function checkPostureParity(facts: PostureFacts, claims: readonly PostureClaim[] = POSTURE_CLAIMS): ParityReport {
  const results = claims.map((c): ParityResult => {
    let evidence: ClaimEvidence;
    try {
      evidence = c.evaluate(facts);
    } catch {
      evidence = "unknown";
    }
    return {
      key: c.key,
      control: c.control,
      docStatus: c.docStatus,
      evidence,
      proof: c.proof,
      violation: c.docStatus === "in_place" && evidence === "gap",
      understated: c.docStatus !== "in_place" && evidence === "proven",
    };
  });
  return {
    results,
    violations: results.filter((r) => r.violation).length,
    unknown: results.filter((r) => r.evidence === "unknown").length,
    proven: results.filter((r) => r.evidence === "proven").length,
  };
}

/** Parse the "Control status" table rows from the posture document:
 *  `| Control | Status | \`evidence.key\` |`. Pure. */
export function parseDocClaims(md: string): Array<{ key: string; status: ClaimStatus | null; statusText: string }> {
  const section = md.split(/^## Control status\s*$/m)[1];
  if (!section) return [];
  const body = section.split(/^## /m)[0];
  const rows: Array<{ key: string; status: ClaimStatus | null; statusText: string }> = [];
  for (const line of body.split("\n")) {
    const m = /^\|(.+)\|\s*$/.exec(line.trim());
    if (!m) continue;
    const cells = m[1].split("|").map((c) => c.trim());
    const keyCell = cells.find((c) => /^`[a-z0-9_.]+`$/.test(c));
    if (!keyCell) continue;
    const statusText = cells[1] ?? "";
    const status =
      (Object.entries(STATUS_WORDS) as Array<[ClaimStatus, string]>).find(([, w]) => statusText.toLowerCase().startsWith(w.toLowerCase()))?.[0] ?? null;
    rows.push({ key: keyCell.slice(1, -1), status, statusText });
  }
  return rows;
}

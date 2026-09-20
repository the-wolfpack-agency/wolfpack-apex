/**
 * Know the Principal - deterministic verification of the human/mandate behind
 * an inbound agent.
 *
 * The market verifies "is this a bot" (Web Bot Auth signs the agent SOFTWARE).
 * The leapfrog is verifying the PRINCIPAL: the human or org accountable for the
 * agent, and the MANDATE (the scopes) they authorized it for. An arriving agent
 * presents a signed delegation credential; we verify it against an issuer the
 * workspace registered, then check the agent's actual behavior against the
 * mandate it presented.
 *
 * Honesty rail (the whole point): a credential is "verified" ONLY when its
 * signature checks out against a registered issuer and it has not expired.
 * Anything short of that - absent, malformed, unknown issuer, bad signature,
 * expired - is "claimed", never "verified". Fail-closed by construction.
 *
 * The strongest possible signal lives here: an agent that presented a VALID
 * mandate and then stepped outside it (mandate_exceeded) had authorization and
 * abused it - worse than an anonymous scraper, which never claimed a right.
 *
 * Reuses OGIAM's own delegation signature construction (verifyDelegationSignature
 * over `${timestamp}.${body}`), so an OGIAM-issued delegation and a Forcefield
 * verification agree byte-for-byte instead of drifting in prose.
 */
import { hasDatabase, query, safeQuery } from "@/lib/db";
import { verifyDelegationSignature } from "@/lib/ogiam/delegate";

import {
  type PrincipalStatus,
  type DelegationBody,
  type PrincipalVerdict,
  type DelegationIssuer,
  type MandateCheck,
} from "@/lib/forcefield/principal-types";

export type { PrincipalStatus, DelegationBody, PrincipalVerdict, DelegationIssuer, MandateCheck };
export { scopeMatches, checkMandate } from "@/lib/forcefield/principal-types";

const MAX_CREDENTIAL_BYTES = 8 * 1024;

/** Decode the compact wire form `<base64url(body)>.<timestamp>.<signature>`.
 *  Returns null on any structural problem - a malformed credential is never
 *  verified, only ever "claimed". */
export function parseDelegation(
  raw: string,
): { body: DelegationBody; bodyJson: string; timestamp: number; signature: string } | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_CREDENTIAL_BYTES) return null;
  const parts = raw.split(".");
  if (parts.length !== 3) return null;
  const [b64, tsStr, signature] = parts;
  const timestamp = Number(tsStr);
  if (!Number.isFinite(timestamp) || timestamp <= 0 || !signature) return null;
  let bodyJson: string;
  try {
    bodyJson = Buffer.from(b64, "base64url").toString("utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyJson);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.principal !== "string" || typeof o.issuer !== "string") return null;
  const scopes = Array.isArray(o.scopes) ? o.scopes.filter((s): s is string => typeof s === "string") : [];
  const body: DelegationBody = {
    principal: o.principal,
    issuer: o.issuer,
    scopes,
    audience: typeof o.audience === "string" ? o.audience : undefined,
    exp: typeof o.exp === "number" ? o.exp : undefined,
  };
  return { body, bodyJson, timestamp, signature };
}

export interface VerifyDelegationOptions {
  /** Resolve the trusted secret + constraints for an issuer, or null if unknown. */
  resolveIssuer: (issuer: string) => DelegationIssuer | null | Promise<DelegationIssuer | null>;
  /** Current time (epoch seconds). Injected for determinism in tests. */
  nowSeconds: number;
  /** Our expected audience; when set, a mismatch downgrades to "claimed". */
  audience?: string;
}

/**
 * Verify a presented delegation credential. Fail-closed: only a clean
 * cryptographic verification against a registered issuer yields "verified".
 */
export async function verifyPresentedDelegation(
  raw: string | null | undefined,
  opts: VerifyDelegationOptions,
): Promise<PrincipalVerdict> {
  if (!raw) return { status: "absent", scopes: [], reason: "No delegation credential presented." };

  const parsed = parseDelegation(raw);
  if (!parsed) {
    return { status: "claimed", scopes: [], reason: "Delegation credential was malformed and could not be decoded." };
  }
  const { body, bodyJson, timestamp, signature } = parsed;

  const issuer = await opts.resolveIssuer(body.issuer);
  if (!issuer) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: `Issuer "${body.issuer}" is not a registered, trusted delegation issuer for this workspace.`,
    };
  }

  const signatureOk = verifyDelegationSignature(issuer.secret, bodyJson, timestamp, signature);
  if (!signatureOk) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: "Delegation signature did not verify against the registered issuer key.",
    };
  }

  if (typeof body.exp === "number" && body.exp <= opts.nowSeconds) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: "Delegation credential has expired.",
    };
  }

  if (opts.audience && body.audience && body.audience !== opts.audience) {
    return {
      status: "claimed",
      principal: body.principal,
      issuer: body.issuer,
      scopes: [],
      reason: `Delegation was minted for a different audience ("${body.audience}").`,
    };
  }

  // Defense in depth: an issuer may cap the scopes it is ever allowed to grant.
  const scopes =
    issuer.allowedScopes.length > 0
      ? body.scopes.filter((s) => issuer.allowedScopes.includes(s))
      : body.scopes;

  return {
    status: "verified",
    principal: body.principal,
    issuer: body.issuer,
    scopes,
    audience: body.audience,
    reason: "Signature verified against a registered issuer; the principal and mandate are proven.",
  };
}

// ── Issuer registry (workspace-scoped) ───────────────────────────────────────

/** Load one trusted issuer for a workspace, or null. Never throws. */
export async function getDelegationIssuer(
  workspaceId: string,
  issuer: string,
): Promise<DelegationIssuer | null> {
  if (!hasDatabase()) return null;
  const res = await safeQuery<{ issuer: string; algorithm: string; secret: string; allowed_scopes: string[] }>(
    `SELECT issuer, algorithm, secret, allowed_scopes
       FROM instinct_delegation_issuers
      WHERE workspace_id = $1 AND issuer = $2
      LIMIT 1`,
    [workspaceId, issuer],
  );
  const row = res?.rows[0];
  if (!row) return null;
  return { issuer: row.issuer, algorithm: "hs256", secret: row.secret, allowedScopes: row.allowed_scopes ?? [] };
}

/** List a workspace's trusted issuers WITHOUT their secrets (for the admin UI). */
export async function listDelegationIssuers(
  workspaceId: string,
): Promise<Array<{ issuer: string; algorithm: string; allowedScopes: string[]; createdAt: string }>> {
  if (!hasDatabase()) return [];
  const res = await safeQuery<{ issuer: string; algorithm: string; allowed_scopes: string[]; created_at: string }>(
    `SELECT issuer, algorithm, allowed_scopes, created_at
       FROM instinct_delegation_issuers
      WHERE workspace_id = $1
      ORDER BY created_at DESC`,
    [workspaceId],
  );
  return (res?.rows ?? []).map((r) => ({
    issuer: r.issuer,
    algorithm: r.algorithm,
    allowedScopes: r.allowed_scopes ?? [],
    createdAt: r.created_at,
  }));
}

/** Register (or rotate) a trusted issuer for a workspace. Upsert on (ws, issuer). */
export async function registerDelegationIssuer(input: {
  workspaceId: string;
  issuer: string;
  secret: string;
  allowedScopes?: string[];
  createdBy?: string;
}): Promise<void> {
  if (!hasDatabase()) return;
  await query(
    `INSERT INTO instinct_delegation_issuers (workspace_id, issuer, algorithm, secret, allowed_scopes, created_by)
     VALUES ($1, $2, 'hs256', $3, $4, $5)
     ON CONFLICT (workspace_id, issuer) DO UPDATE
       SET secret = EXCLUDED.secret, allowed_scopes = EXCLUDED.allowed_scopes, updated_at = now()`,
    [input.workspaceId, input.issuer, input.secret, input.allowedScopes ?? [], input.createdBy ?? null],
  );
}

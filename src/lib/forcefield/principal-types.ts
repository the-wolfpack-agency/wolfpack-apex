/**
 * Know the Principal - the PURE, dependency-free core (types + scope/mandate
 * logic). No Node crypto, no pg, no Buffer: safe to import from modules that end
 * up in the client bundle (agent-behavior, agent-operators-view). The signing /
 * verifying / DB registry side lives in ./principal.ts, which is server-only.
 */
export type PrincipalStatus = "verified" | "claimed" | "absent";

/** The decoded body an agent signs and presents. Non-PII by contract. */
export interface DelegationBody {
  principal: string;
  issuer: string;
  scopes: string[];
  audience?: string;
  /** Expiry, epoch seconds. Absent = does not expire (discouraged). */
  exp?: number;
}

export interface PrincipalVerdict {
  status: PrincipalStatus;
  principal?: string;
  issuer?: string;
  /** Scopes as presented (only trustworthy when status === "verified"). */
  scopes: string[];
  audience?: string;
  reason: string;
}

/** A registered issuer a workspace trusts to sign delegations. */
export interface DelegationIssuer {
  issuer: string;
  algorithm: "hs256";
  secret: string;
  allowedScopes: string[];
}

export interface MandateCheck {
  withinScope: boolean;
  /** Paths the agent touched that no presented scope authorized. */
  violations: string[];
}

/** Does a single scope authorize a path? A scope is a path prefix; a trailing
 *  "*" (or a bare "*"/"/*") is an explicit wildcard. Deterministic + pure. */
export function scopeMatches(scope: string, path: string): boolean {
  const s = scope.trim();
  if (s === "*" || s === "/*") return true;
  const p = path.split("?")[0];
  const base = s.endsWith("/*") ? s.slice(0, -2) : s.endsWith("*") ? s.slice(0, -1) : s;
  if (base === "") return true;
  return p === base || p.startsWith(base.endsWith("/") ? base : base + "/");
}

/**
 * Check the agent's ACTUAL paths against the mandate it presented. Only
 * meaningful for a verified principal; a claimed/absent principal has no proven
 * mandate to exceed, so it is trivially within-scope (nothing was granted).
 */
export function checkMandate(verdict: PrincipalVerdict, paths: readonly string[]): MandateCheck {
  if (verdict.status !== "verified" || verdict.scopes.length === 0) {
    return { withinScope: true, violations: [] };
  }
  const violations: string[] = [];
  for (const path of paths) {
    if (!verdict.scopes.some((sc) => scopeMatches(sc, path))) violations.push(path);
  }
  return { withinScope: violations.length === 0, violations };
}

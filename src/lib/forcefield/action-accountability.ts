/**
 * Accountable actions, server side: verify a presented delegation at the
 * boundary and fold the verdict into the event's props.
 *
 * The edge stamps a provisional accountability verdict on a state-changing
 * request (src/lib/forcefield-web/accountability.ts) but can never verify a
 * principal: it holds no issuer keys. The two server boundaries that receive
 * events (the vendored-site ingest and the central observe route) call this one
 * helper, so both verify the same way and record the same props:
 *   - props.principal_status / principal / principal_issuer / principal_scopes
 *     (the existing Know the Principal props; the raw credential is never kept)
 *   - the action verdict refined: a verified principal becomes
 *     "signed_principal" with props.mandate within/outside; a claimed one makes
 *     the action unaccountable (unless the site attested the session).
 * Never throws; watch mode only.
 */
import { verifyPresentedDelegation, getDelegationIssuer, consumeDelegationJti } from "@/lib/forcefield/principal";
import { scopeMatches, type PrincipalVerdict } from "@/lib/forcefield/principal-types";
import { applyPrincipalToAction } from "@/lib/forcefield-web/accountability";

/** Verify a presented credential with the boundary's standard options: a
 *  10-minute signing window and single-use jti. "absent" when none. */
export async function verifyBoundaryDelegation(presented: string | null, workspaceId: string): Promise<PrincipalVerdict> {
  try {
    return await verifyPresentedDelegation(presented, {
      resolveIssuer: (iss) => getDelegationIssuer(workspaceId, iss),
      nowSeconds: Math.floor(Date.now() / 1000),
      audience: process.env.SITE_ANALYTICS_AUDIENCE,
      maxAgeSeconds: 600,
      consumeJti: (jti, exp) => consumeDelegationJti(workspaceId, jti, exp),
    });
  } catch {
    // Fail closed: a verifier error is never a verified principal.
    return { status: presented ? "claimed" : "absent", scopes: [], reason: "Delegation could not be verified." };
  }
}

/**
 * Stamp a principal verdict onto event props, and refine the action verdict
 * for `path` when the event carries one. Mutates and returns `props`.
 */
export function stampPrincipal(
  props: Record<string, string | number | boolean>,
  verdict: PrincipalVerdict,
  path: string,
): Record<string, string | number | boolean> {
  // Only THIS boundary can prove a principal: a "signed_principal" verdict that
  // arrived in the body without a verified credential is downgraded.
  if (verdict.status !== "verified" && (props.accountability === "signed_principal" || props.mandate !== undefined)) {
    delete props.mandate;
    if (props.accountability === "signed_principal") {
      props.accountability = "unaccountable";
      props.acct_reason = "principal_unverified";
      props.would_hold = true;
    }
  }
  if (verdict.status === "absent") return props;
  props.principal_status = verdict.status;
  if (verdict.principal) props.principal = verdict.principal.slice(0, 120);
  if (verdict.issuer) props.principal_issuer = verdict.issuer.slice(0, 120);
  if (verdict.scopes.length > 0) props.principal_scopes = JSON.stringify(verdict.scopes).slice(0, 400);
  const withinMandate = verdict.status === "verified" && verdict.scopes.some((s) => scopeMatches(s, path));
  return applyPrincipalToAction(props, verdict.status === "verified" ? { status: "verified", withinMandate } : { status: "claimed" });
}

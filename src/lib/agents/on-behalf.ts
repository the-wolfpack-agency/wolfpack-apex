/**
 * On-behalf-of (delegation) tokens, RFC 8693 actor-token delegation.
 *
 * Problem: an agent needs to call an internal route AS its human owner, so the
 * route's existing capability gate enforces the OWNER's authority, never the
 * agent's, never elevated. A pure agent credential (kind:"agent",
 * aud:"ogiam-agent") deliberately cannot be a human session (see identity.ts),
 * so it cannot be used here. We need a SEPARATE, owner-identity credential that
 * records who is really acting.
 *
 * Design (RFC 8693): the token's subject/identity is the OWNER, so downstream
 * authorization resolves the owner's capabilities. It carries an `act` claim
 * (the actor claim) naming the agent that is really acting, for full audit of
 * the delegation. The audience is a DISTINCT value, "instinct-onbehalf", which
 * is neither the normal human-session audience nor the agent audience
 * "ogiam-agent", so an on-behalf token can never be confused with either, and
 * neither of those can be accepted on the on-behalf path.
 *
 * Security properties:
 *   - Owner-bounded authority. The identity is the owner; the route enforces the
 *     owner's capabilities. The agent never gains authority it could not already
 *     exercise through its owner.
 *   - Very short lived (default 60s). No refresh semantics, a delegation is a
 *     single bounded act, not a session. If it expires mid-flight, mint a new one.
 *   - Audience-segregated. aud === "instinct-onbehalf" is required on verify;
 *     anything else (human token, agent token, tampered token) is rejected.
 *   - Signed and verified ONLY through the crypto-agility registry
 *     (src/lib/crypto/sign). No direct jsonwebtoken usage here.
 *   - The token is never logged. Callers receive only the verified context.
 */

import { signToken, verifyToken } from "@/lib/crypto/sign";

/**
 * Distinct delegation audience. NOT the normal human-session audience and NOT
 * the agent audience ("ogiam-agent"). The verifier requires exactly this value,
 * which is what segregates on-behalf tokens from every other token family.
 */
export const ON_BEHALF_AUDIENCE = "instinct-onbehalf" as const;

/**
 * Default delegation lifetime: 60 seconds. A delegation is a single bounded act,
 * not a session, so the TTL is far shorter than a human/agent access token.
 */
export const ON_BEHALF_TOKEN_TTL_SECONDS = 60;

export interface MintOnBehalfInput {
  /** The accountable human owner. Becomes the token subject/identity. */
  ownerUserId: string;
  /** The owner's role. Downstream capability resolution uses this. */
  ownerRole: string;
  /** Tenant scope. Carried through so the route stays workspace-scoped. */
  workspaceId: string;
  /** The agent that is really acting. Recorded in the RFC 8693 `act` claim. */
  agentId: string;
}

/** The verified, in-request delegation context. */
export interface OnBehalfContext {
  /** The owner the delegated call runs as. */
  ownerUserId: string;
  /** The owner's role, the authority the route enforces. */
  ownerRole: string;
  /** Tenant scope. */
  workspaceId: string;
  /** The agent that is really acting (from the `act` claim), for audit. */
  actingAgentId: string;
}

/**
 * Claims carried by an on-behalf token.
 *
 * The subject (`sub`) is the OWNER, so downstream authorization treats this as
 * the owner acting. `kind` is "on-behalf" (NOT "agent", an agent credential is
 * a different family and is rejected by the human resolver). `act` is the RFC
 * 8693 actor claim recording who is really acting. There are deliberately no
 * email/name fields and no refresh handle: this is a single, bounded act.
 */
interface OnBehalfTokenClaims {
  /** Subject: the OWNER user id. Authorization runs as the owner. */
  sub: string;
  /** Marks this token family. Not "agent": this is an owner-identity token. */
  kind: "on-behalf";
  /** Distinct delegation audience. The verifier requires exactly this. */
  aud: typeof ON_BEHALF_AUDIENCE;
  /** The owner's role, so the route resolves the owner's capabilities. */
  ownerRole: string;
  /** Tenant scope. */
  workspaceId: string;
  /** RFC 8693 actor claim: who is really acting (the agent). */
  act: { agent: string };
  /** Standard JWT timestamps (added by the signer). */
  iat?: number;
  exp?: number;
}

/**
 * Mint an on-behalf-of delegation token. Signs THROUGH the crypto registry a
 * short-lived JWT whose identity is the OWNER, carrying the RFC 8693 `act` claim
 * that names the acting agent. No refresh semantics. The returned token is never
 * logged by this module.
 *
 * @param input  owner identity + role + workspace + the acting agent id.
 * @param ttlSeconds  delegation lifetime, default 60s. A single bounded act.
 */
export async function mintOnBehalfToken(
  input: MintOnBehalfInput,
  ttlSeconds: number = ON_BEHALF_TOKEN_TTL_SECONDS,
): Promise<string> {
  const claims: Omit<OnBehalfTokenClaims, "iat" | "exp"> = {
    sub: input.ownerUserId,
    kind: "on-behalf",
    aud: ON_BEHALF_AUDIENCE,
    ownerRole: input.ownerRole,
    workspaceId: input.workspaceId,
    act: { agent: input.agentId },
  };
  // Signed only through the crypto-agility registry. Never log the token.
  return signToken(claims, { ttlSeconds });
}

/**
 * Synchronous verification core. The crypto registry's verifyToken is itself
 * synchronous (and never throws), so the real work needs no Promise. Exposing a
 * sync core lets the human resolver (getUserFromRequest, which is synchronous)
 * accept on-behalf tokens without duplicating a single line of this logic, while
 * the public API below stays async as designed.
 *
 * Returns the owner context plus the acting agent, or null on ANY failure:
 * invalid signature, expired, wrong audience, wrong kind, or missing claims.
 */
export function verifyOnBehalfTokenSync(token: string): OnBehalfContext | null {
  try {
    const res = verifyToken<OnBehalfTokenClaims>(token);
    // Invalid signature OR expired: the crypto layer returns valid:false. We do
    // not distinguish here, any non-valid result is a rejection.
    if (!res.valid) return null;
    const c = res.payload;
    // Audience segregation is the core boundary: only our distinct delegation
    // audience is accepted. A human token, an agent token (aud "ogiam-agent"),
    // or anything else is rejected here even though it verified.
    if (c.aud !== ON_BEHALF_AUDIENCE) return null;
    // Defense in depth: this must be the on-behalf family, never an agent token.
    if (c.kind !== "on-behalf") return null;
    // Required shape: owner identity, role, workspace, and a named acting agent.
    if (!c.sub || !c.ownerRole || !c.workspaceId) return null;
    const actingAgentId = c.act?.agent;
    if (!actingAgentId || typeof actingAgentId !== "string") return null;
    return {
      ownerUserId: c.sub,
      ownerRole: c.ownerRole,
      workspaceId: c.workspaceId,
      actingAgentId,
    };
  } catch {
    // verifyToken never throws, but guard anyway: callers must get null, never
    // an exception, on any failure.
    return null;
  }
}

/**
 * Verify an on-behalf-of token. Verifies the signature via the crypto registry,
 * requires aud === ON_BEHALF_AUDIENCE, requires a well-formed `act` claim, and
 * (because the crypto layer rejects expired tokens) is unexpired. Returns the
 * owner context plus the acting agent, or null on ANY failure.
 *
 * Never throws to callers, every failure path returns null. Expired, wrong
 * audience, tampered signature, missing claims, and malformed input all map to
 * null, so a route can treat "non-null" as "a valid, unexpired delegation."
 */
export async function verifyOnBehalfToken(
  token: string,
): Promise<OnBehalfContext | null> {
  return verifyOnBehalfTokenSync(token);
}

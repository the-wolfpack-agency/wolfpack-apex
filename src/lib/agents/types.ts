/**
 * Agent principal types. An agent is an organizational principal with a role,
 * an accountable human owner, and a lifecycle, onboarded like a person.
 */

export type AgentState = "invited" | "active" | "paused" | "revoked";
export type AgentIdentityProvider = "local" | "entra";
export type AgentScanStatus = "pending" | "complete";

/** A row in instinct_agents (the secret hash is never exposed off the store). */
export interface AgentRecord {
  id: string;
  workspaceId: string;
  name: string;
  role: string;
  ownerUserId: string;
  state: AgentState;
  identityProvider: AgentIdentityProvider;
  externalSubject: string | null;
  scanStatus: AgentScanStatus;
  description: string | null;
  createdBy: string;
  createdAt: string;
  activatedAt: string | null;
  lastSeenAt: string | null;
  revokedAt: string | null;
  /** Operations this agent may run per hour. 0 = unlimited, set deliberately. */
  maxOperationsPerHour?: number;
  /** Connector names bound to this agent (migration 183). Populated by
   *  listAgents; defaults to [] for single-record reads that don't join it. */
  connections: string[];
}

/**
 * The verified, in-request representation of an agent. This is what an agent
 * action runs as: the actor is the agent itself, with its owner recorded for
 * accountability. Deliberately distinct from a human TeamMember so the two can
 * never be confused on a gated route.
 */
export interface AgentPrincipal {
  agentId: string;
  role: string;
  workspaceId: string;
  ownerUserId: string;
  provider: AgentIdentityProvider;
}

/** Claims carried by a local agent access token. */
export interface AgentTokenClaims {
  /** Subject: the agent id. */
  sub: string;
  /** Marks this as an agent credential. The human verifier rejects this, and
   *  the agent verifier requires it, so the two token families never cross. */
  kind: "agent";
  /** Audience: a fixed value the agent verifier checks (defense in depth). */
  aud: "ogiam-agent";
  role: string;
  workspaceId: string;
  ownerUserId: string;
  provider: AgentIdentityProvider;
}

export interface IssueTokenInput {
  agentId: string;
  role: string;
  workspaceId: string;
  ownerUserId: string;
  /** Seconds. Defaults to a short access-token TTL. */
  ttlSeconds?: number;
}

export interface IssuedToken {
  token: string;
  /** Unix seconds at which the token expires. */
  expiresAt: number;
  provider: AgentIdentityProvider;
}

/**
 * Pluggable agent identity provider. The local provider mints short-lived
 * signed tokens to prove the loop now; the Entra provider validates Microsoft
 * Entra workload-identity OIDC tokens for production and client deployments.
 * Call sites depend only on this interface, so the swap is a config change.
 */
export interface AgentIdentity {
  readonly provider: AgentIdentityProvider;
  /** Issue a short-lived access token for an agent. Local provider only; the
   *  Entra provider returns a not-supported result because Entra issues tokens
   *  itself (we only verify them). */
  issueAccessToken(input: IssueTokenInput): Promise<IssuedToken | null>;
  /** Verify a presented token and return the agent principal, or null. Never
   *  throws. */
  verifyAccessToken(token: string): Promise<AgentPrincipal | null>;
}

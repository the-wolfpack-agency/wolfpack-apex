/**
 * Agent identity providers.
 *
 * Design: identity is a portable, standards-based credential; authorization is
 * OGIAM policy applied locally at each system. The agent token says who the
 * agent is; OGIAM (and the capability gate) say what it may do. That separation
 * is what lets the same agent be governed inside Instinct today and inside a
 * client's platform later, with no bespoke coupling.
 *
 * Two providers behind one interface:
 *   - LocalAgentIdentity: mints short-lived signed JWTs through the crypto
 *     agility registry, to prove the onboarding and action loop now.
 *   - EntraAgentIdentity: validates Microsoft Entra workload-identity OIDC
 *     tokens (the production and client-deployment path). Best practice there is
 *     short-lived, scoped, sender-constrained (DPoP) tokens with federated
 *     credentials so there is no stored secret. Wired as a config-gated stub
 *     until the Entra tenant + JWKS are configured; swapping providers is a
 *     single env change, no call-site edits.
 *
 * Security boundary: agent tokens carry kind:"agent" and aud:"ogiam-agent". The
 * human verifier (getUserFromRequest) rejects kind:"agent", and this verifier
 * requires it, so an agent credential can never be used as a human session and
 * a human session can never act as an agent.
 */

import { signToken, verifyToken } from "@/lib/crypto/sign";
import type {
  AgentIdentity,
  AgentPrincipal,
  AgentTokenClaims,
  IssueTokenInput,
  IssuedToken,
} from "./types";

/** Default agent access-token lifetime: short, like a human access token. */
export const AGENT_TOKEN_TTL_SECONDS = 15 * 60;
const AGENT_AUDIENCE = "ogiam-agent" as const;

function toPrincipal(claims: AgentTokenClaims): AgentPrincipal {
  return {
    agentId: claims.sub,
    role: claims.role,
    workspaceId: claims.workspaceId,
    ownerUserId: claims.ownerUserId,
    provider: claims.provider,
  };
}

export class LocalAgentIdentity implements AgentIdentity {
  readonly provider = "local" as const;

  async issueAccessToken(input: IssueTokenInput): Promise<IssuedToken> {
    const ttl = input.ttlSeconds ?? AGENT_TOKEN_TTL_SECONDS;
    const claims: Omit<AgentTokenClaims, "iat" | "exp"> = {
      sub: input.agentId,
      kind: "agent",
      aud: AGENT_AUDIENCE,
      role: input.role,
      workspaceId: input.workspaceId,
      ownerUserId: input.ownerUserId,
      provider: this.provider,
    };
    const token = signToken(claims, { ttlSeconds: ttl });
    return { token, expiresAt: Math.floor(Date.now() / 1000) + ttl, provider: this.provider };
  }

  async verifyAccessToken(token: string): Promise<AgentPrincipal | null> {
    try {
      const res = verifyToken<AgentTokenClaims>(token);
      if (!res.valid) return null;
      const c = res.payload;
      // Both checks are required: this must be an agent credential for our
      // audience, not a human session token that happens to verify.
      if (c.kind !== "agent" || c.aud !== AGENT_AUDIENCE) return null;
      if (!c.sub || !c.role || !c.workspaceId || !c.ownerUserId) return null;
      return toPrincipal(c);
    } catch {
      return null;
    }
  }
}

/**
 * Entra workload-identity provider. Validates an OIDC token from the configured
 * Entra tenant against its JWKS and maps the verified subject to an agent
 * principal. Config-gated: until OGIAM_AGENT_ENTRA_* is set, verify returns null
 * and issue returns null (Entra issues its own tokens; we only verify them).
 *
 * Left as a typed seam on purpose: the OIDC validation (JWKS fetch + signature +
 * issuer/audience/expiry checks) lands when the tenant exists, without touching
 * any caller.
 */
export class EntraAgentIdentity implements AgentIdentity {
  readonly provider = "entra" as const;
  constructor(
    private readonly cfg: { tenantId: string; audience: string; jwksUri: string },
  ) {}

  async issueAccessToken(): Promise<IssuedToken | null> {
    // Entra mints its own tokens (workload identity federation). We do not issue.
    return null;
  }

  async verifyAccessToken(_token: string): Promise<AgentPrincipal | null> {
    // OIDC validation against this.cfg.jwksUri lands with the live tenant.
    void this.cfg;
    return null;
  }
}

interface EntraConfig {
  tenantId: string;
  audience: string;
  jwksUri: string;
}

function readEntraConfig(env: NodeJS.ProcessEnv): EntraConfig | null {
  const tenantId = env.OGIAM_AGENT_ENTRA_TENANT_ID;
  const audience = env.OGIAM_AGENT_ENTRA_AUDIENCE;
  if (
    env.OGIAM_AGENT_IDENTITY_PROVIDER === "entra" &&
    tenantId &&
    audience
  ) {
    return {
      tenantId,
      audience,
      jwksUri:
        env.OGIAM_AGENT_ENTRA_JWKS_URI ??
        `https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`,
    };
  }
  return null;
}

/** Resolve the active agent identity provider from config. Local by default. */
export function getAgentIdentity(env: NodeJS.ProcessEnv = process.env): AgentIdentity {
  const entra = readEntraConfig(env);
  if (entra) return new EntraAgentIdentity(entra);
  return new LocalAgentIdentity();
}

/**
 * Resolve an agent principal from an Authorization header. Returns null when the
 * header is missing, not a bearer token, or not a valid agent credential. This
 * is the agent-side counterpart to getUserFromRequest, and the two are mutually
 * exclusive by the kind/aud checks.
 */
export async function resolveAgentFromRequest(
  authHeader: string | null,
  identity: AgentIdentity = getAgentIdentity(),
): Promise<AgentPrincipal | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;
  return identity.verifyAccessToken(authHeader.slice(7));
}

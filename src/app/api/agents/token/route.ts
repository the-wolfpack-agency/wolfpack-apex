/**
 * POST /api/agents/token: the agent's machine login (OGIAM).
 *
 * This is the one OGIAM route with NO capability gate: the onboarding secret IS
 * the credential. The agent presents { agent_id, onboarding_secret }; on a valid
 * match the store activates the agent and we mint a short-lived access token.
 *
 * Security posture:
 *   - Generic 401 on any failure. We never reveal whether the id or the secret
 *     was wrong (anti-enumeration), and the secret is never logged.
 *   - Per-agent_id rate limit (10/min) to blunt secret brute-forcing. Mirrors the
 *     in-memory limiter used by /api/feedback; swap for Redis when multi-replica.
 *   - Cache-Control: no-store on every response so the token never lands in a
 *     shared cache.
 *   - The local provider self-issues; the Entra provider does not (it validates
 *     tokens Entra mints). When issueAccessToken returns null we surface 501
 *     rather than pretend to have a token.
 */

import { NextRequest, NextResponse } from "next/server";
import { activateWithOnboardingSecret, recordAgentSeen } from "@/lib/agents/store";
import { getAgentIdentity, AGENT_TOKEN_TTL_SECONDS } from "@/lib/agents/identity";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

/* --------------------- Per-agent rate limiter ------------------------- */

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 10;
const attempts = new Map<string, { count: number; windowStart: number }>();

export function _isRateLimited(
  agentId: string,
  now = Date.now(),
): { limited: boolean; retryAfter: number } {
  const entry = attempts.get(agentId);
  if (!entry || now - entry.windowStart >= WINDOW_MS) {
    attempts.set(agentId, { count: 1, windowStart: now });
    return { limited: false, retryAfter: 0 };
  }
  if (entry.count >= MAX_PER_WINDOW) {
    const retryAfter = Math.ceil((WINDOW_MS - (now - entry.windowStart)) / 1000);
    return { limited: true, retryAfter: Math.max(retryAfter, 1) };
  }
  entry.count++;
  return { limited: false, retryAfter: 0 };
}

export function _resetRateLimit(): void {
  attempts.clear();
}

const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE, ...(extraHeaders ?? {}) },
  });
}

export async function POST(req: NextRequest) {
  let body: { agent_id?: unknown; onboarding_secret?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid_input", detail: "body must be JSON" }, 400);
  }

  const agentId = typeof body.agent_id === "string" ? body.agent_id.trim() : "";
  const onboardingSecret =
    typeof body.onboarding_secret === "string" ? body.onboarding_secret : "";
  if (!agentId || !onboardingSecret) {
    return json(
      { error: "invalid_input", detail: "agent_id and onboarding_secret are required" },
      400,
    );
  }

  /* Rate-limit per agent_id BEFORE verifying, so a brute-force on one id is
     throttled regardless of whether that id exists. */
  const { limited, retryAfter } = _isRateLimited(agentId);
  if (limited) {
    return json({ error: "rate_limited", retryAfter }, 429, {
      "Retry-After": String(retryAfter),
    });
  }

  /* The store returns null for an unknown id, a bad secret, OR a revoked agent
     and never tells us which. We mirror that: one generic 401, no secret logged. */
  const agent = await activateWithOnboardingSecret(agentId, onboardingSecret);
  if (!agent) {
    return json({ error: "invalid_credentials" }, 401);
  }

  const issued = await getAgentIdentity().issueAccessToken({
    agentId: agent.id,
    role: agent.role,
    workspaceId: agent.workspaceId,
    ownerUserId: agent.ownerUserId,
  });
  if (!issued) {
    /* The active provider does not self-issue (e.g. Entra mints its own tokens).
       Surface that clearly rather than returning an empty token. */
    return json({ error: "issuer_not_local" }, 501);
  }

  await recordAgentSeen(agent.id);

  trackEvent("agent.token_issued", agent.id, agent.role, {
    agent_id: agent.id,
    ttl_seconds: AGENT_TOKEN_TTL_SECONDS,
  });

  /* Issuing an access token to an AI principal is a security-relevant credential
     event: hash-chain it. The token material is never recorded, only that a
     credential was minted, for which principal, by which provider, and its TTL.
     Best-effort: the agent already has its token, so an audit hiccup must not
     fail the login. */
  try {
    await recordAudit({
      actor: { user_id: agent.id, role: agent.role },
      action: "agent.token_issued",
      resourceType: "agent",
      resourceId: agent.id,
      afterState: { provider: issued.provider, ttl_seconds: AGENT_TOKEN_TTL_SECONDS },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[agents/token audit]", (err as Error).message);
  }

  return json(
    {
      token: issued.token,
      expires_at: issued.expiresAt,
      provider: issued.provider,
    },
    200,
  );
}

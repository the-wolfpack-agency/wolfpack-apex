/**
 * POST /api/agents/act: the governed agent action loop (OGIAM).
 *
 * An active agent presents its access token and a natural-language message; we
 * dispatch it through the same tool pipeline the human assistant uses, but with
 * an agentPrincipal in the context so the OGIAM gate runs in ENFORCE mode and
 * attributes every decision to the agent's own identity. High-risk actions are
 * blocked by the gate inside the dispatcher; this route does not re-implement
 * that policy, it only supplies the principal and surfaces the result.
 *
 * Security posture:
 *   - The agent token is the credential. resolveAgentFromRequest verifies it;
 *     a missing / non-agent / expired token yields a generic 401.
 *   - State is re-checked against the DB, never trusted from the token: a
 *     revoked or paused agent (even with a still-valid token) is refused with
 *     403 agent_not_active before any tool runs.
 *   - Per-agent rate limit (30/min) blunts a runaway or hijacked agent. Mirrors
 *     the in-memory limiter on /api/agents/token; swap for Redis when
 *     multi-replica.
 *   - Cache-Control: no-store on every response.
 *
 * Every dispatch fires agent.acted so the learning loop sees what the agent did
 * and whether the gate allowed it.
 */

import { NextRequest, NextResponse } from "next/server";
import { resolveAgentFromRequest } from "@/lib/agents/identity";
import { getAgent } from "@/lib/agents/store";
// Barrel import (not the dispatcher directly) so the FULL tool set is registered
// for the agent act path. Importing from the dispatcher left a partial registry
// and silently no_match'd tools the human path had. See executor.ts.
import { tryDispatchTool } from "@/lib/assistant/tools";
import { trackEvent } from "@/lib/analytics";

/* --------------------- Per-agent rate limiter ------------------------- */

const WINDOW_MS = 60 * 1000;
const MAX_PER_WINDOW = 30;
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

const MAX_MESSAGE_LEN = 2000;
const NO_STORE = { "Cache-Control": "no-store" } as const;

function json(body: unknown, status: number, extraHeaders?: Record<string, string>) {
  return NextResponse.json(body, {
    status,
    headers: { ...NO_STORE, ...(extraHeaders ?? {}) },
  });
}

export async function POST(req: NextRequest) {
  const principal = await resolveAgentFromRequest(req.headers.get("authorization"));
  if (!principal) {
    return json({ error: "invalid_token" }, 401);
  }

  /* Re-verify state from the source of truth: a revoked / paused agent must not
     act even if its token has not yet expired. Missing record is treated the
     same and not distinguished to the caller. */
  const agent = await getAgent(principal.agentId, principal.workspaceId);
  if (!agent || agent.state === "revoked" || agent.state === "paused") {
    return json({ error: "agent_not_active" }, 403);
  }

  /* Rate-limit per agent before doing any work, so a runaway agent can't flood
     the dispatcher. */
  const { limited, retryAfter } = _isRateLimited(principal.agentId);
  if (limited) {
    return json({ error: "rate_limited", retryAfter }, 429, {
      "Retry-After": String(retryAfter),
    });
  }

  let body: { message?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return json({ error: "invalid_input", detail: "body must be JSON" }, 400);
  }

  const message = typeof body.message === "string" ? body.message.trim() : "";
  if (!message) {
    return json(
      { error: "invalid_input", detail: "message is required" },
      400,
    );
  }
  if (message.length > MAX_MESSAGE_LEN) {
    return json(
      { error: "invalid_input", detail: `message must be <= ${MAX_MESSAGE_LEN} chars` },
      400,
    );
  }

  /* The agentPrincipal flips the dispatcher's OGIAM gate into enforce mode and
     attributes the decision to this agent's identity. */
  const ctx = {
    userId: principal.agentId,
    userRole: principal.role,
    workspaceId: principal.workspaceId,
    agentPrincipal: {
      agentId: principal.agentId,
      role: principal.role,
      workspaceId: principal.workspaceId,
      ownerUserId: principal.ownerUserId,
    },
  };

  const result = await tryDispatchTool(message, ctx);

  trackEvent("agent.acted", principal.agentId, principal.role, {
    agent_id: principal.agentId,
    tool: result?.tool ?? "none",
    allowed: Boolean(result?.result.ok),
  });

  return json(
    {
      ok: true,
      dispatched: result ? { tool: result.tool, result: result.result } : null,
    },
    200,
  );
}

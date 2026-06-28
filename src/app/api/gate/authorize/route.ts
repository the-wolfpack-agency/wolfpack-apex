/**
 * POST /api/gate/authorize: the BRING-YOUR-OWN-AGENT gate. The productized moat.
 *
 * This is the model- and framework-agnostic gate-as-a-service. ANY external AI
 * (any model, any framework - LangChain, a raw OpenAI/Anthropic loop, a bespoke
 * agent) authenticates with an API key and asks the OGIAM gate to authorize ONE
 * action BEFORE it executes it. The gate decides DETERMINISTICALLY (a pure policy
 * function), records the decision to the tamper-evident, hash-chained ledger, and
 * returns an allow/deny verdict. That is what lets a client plug their own agent
 * into our safety filter: every external AI runs behind the same deterministic
 * checkpoint, and every call becomes a learning + audit surface.
 *
 * THE CONTRACT (what an external agent sends and gets back):
 *   Request:  Authorization: Bearer <api-key>
 *             { tool: string, capability: string, isMutation?: boolean,
 *               params?: object }
 *             - read-only vs mutating is the CALLER'S isMutation flag combined
 *               with the gate's own rules; the caller declares intent, the gate
 *               decides.
 *   Response: 200 { allowed: boolean, decision: { ruleId, effectiveOutcome,
 *               reason } }   (a non-secret explainability summary ONLY)
 *
 * THIS IS AN AUTHORIZATION QUERY, NOT THE ACTION. A gate DENY-BY-POLICY is a 200
 * with { allowed: false }, NEVER a 403: the HTTP status reports whether the QUERY
 * was served; the verdict lives in the body. The caller branches on `allowed`,
 * never on the status code. Reserved error statuses (the key may not even ASK):
 *   401 - missing / malformed / not-found / revoked key (generic message; we
 *         never reveal which part failed).
 *   429 - the key is over its rate-limit budget.
 *   400 - the body is missing required fields.
 *   403 - the requested capability is OUT OF SCOPE for this key. (Defense in
 *         depth: a key can only authorize what it was granted; we reject before
 *         ever consulting the gate. We use a 403 here because it is a "you may
 *         not ask" condition, distinct from a gate deny.)
 *
 * FAIL-CLOSED, NEVER LEAK: auth/rate-limit/scope failures all deny; the response
 * never echoes the caller's params, never reveals the workspace, and the gate's
 * own ledger (not this route) is the audit of record - so this route DELEGATES
 * auditing (see AUDIT_ALLOWLIST). The raw key never enters analytics or a log.
 *
 * Analytics: platform.gate_api_authorized fires on a served verdict (allow OR
 * policy-deny); platform.gate_api_blocked fires on every pre-gate rejection
 * (auth_failed / rate_limited / out_of_scope / bad_request) so demand and abuse
 * are both visible to the learning loop.
 */
import { NextRequest, NextResponse } from "next/server";
import { verifyApiKey } from "@/lib/ogiam/api-keys";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { authorize } from "@/lib/ogiam/authorize";
import { trackEvent } from "@/lib/analytics";

/** Generic auth-failure message - never reveals which part failed. */
const AUTH_FAILED = "invalid or missing API key";

interface GateBody {
  tool?: unknown;
  capability?: unknown;
  isMutation?: unknown;
  params?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  // 1. AUTH. Extract the bearer key; verify it. Any failure -> generic 401.
  const authHeader = req.headers.get("authorization") ?? "";
  const rawKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";

  const key = rawKey
    ? await verifyApiKey(rawKey)
    : ({ ok: false, reason: "malformed" } as const);

  if (!key.ok) {
    // Do NOT differentiate not_found / revoked / malformed to the caller. The
    // analytics row carries the reason internally for our own observability;
    // the HTTP body stays generic.
    trackEvent("platform.gate_api_blocked", "external_agent", "external_agent", {
      reason: "auth_failed",
      detail: key.reason,
    });
    return NextResponse.json({ error: AUTH_FAILED }, { status: 401 });
  }

  // 2. RATE LIMIT. Per-key fixed-window budget; over -> 429.
  const rl = await checkRateLimit(key.id);
  if (!rl.ok) {
    trackEvent(
      "platform.gate_api_blocked",
      `apikey:${key.id}`,
      "external_agent",
      { reason: "rate_limited", agent: key.agent },
    );
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  // 3. VALIDATE BODY. Missing required fields -> 400.
  let body: GateBody;
  try {
    body = (await req.json()) as GateBody;
  } catch {
    trackEvent(
      "platform.gate_api_blocked",
      `apikey:${key.id}`,
      "external_agent",
      { reason: "bad_request", agent: key.agent },
    );
    return NextResponse.json({ error: "invalid_json" }, { status: 400 });
  }

  const tool = typeof body.tool === "string" ? body.tool.trim() : "";
  const capability =
    typeof body.capability === "string" ? body.capability.trim() : "";
  const isMutation = body.isMutation === true;
  const params =
    body.params && typeof body.params === "object" && !Array.isArray(body.params)
      ? (body.params as Record<string, unknown>)
      : {};

  if (!tool || !capability) {
    trackEvent(
      "platform.gate_api_blocked",
      `apikey:${key.id}`,
      "external_agent",
      { reason: "bad_request", agent: key.agent },
    );
    return NextResponse.json(
      { error: "tool and capability are required" },
      { status: 400 },
    );
  }

  // 4. SCOPE. The requested capability MUST be one the key was granted. Defense
  // in depth on top of the gate: a key can only authorize what it holds. Reject
  // BEFORE consulting the gate (a "you may not ask" condition -> 403).
  if (!key.capabilities.includes(capability)) {
    trackEvent(
      "platform.gate_api_blocked",
      `apikey:${key.id}`,
      "external_agent",
      { reason: "out_of_scope", agent: key.agent, capability },
    );
    return NextResponse.json(
      { allowed: false, reason: "capability_out_of_scope" },
      { status: 403 },
    );
  }

  // 5. DELEGATE TO THE GATE. It decides deterministically and records the
  // decision to the tamper-evident ledger (and fails closed on an unauditable
  // decision in enforce mode). We never reimplement gate logic here.
  const decision = await authorize({
    principal: {
      kind: "ai_agent",
      agent: key.agent,
      onBehalfOfUserId: `apikey:${key.id}`,
      onBehalfOfRole: "external_agent",
      workspaceId: key.workspaceId,
    },
    tool,
    capability,
    isMutation,
    surface: "/external",
    params,
    mode: "enforce",
  });

  const allowed = decision.effectiveOutcome === "allow";

  // A served verdict (allow OR policy-deny). Fire the authorized event; the gate
  // ledger is the audit of record for the decision itself.
  trackEvent(
    "platform.gate_api_authorized",
    `apikey:${key.id}`,
    "external_agent",
    { agent: key.agent, tool, outcome: decision.effectiveOutcome },
  );

  // Return ONLY a non-secret explainability summary. Never echo params, never
  // reveal the principal/workspace. A gate deny is a 200 { allowed: false }.
  return NextResponse.json({
    allowed,
    decision: {
      ruleId: decision.ruleId,
      effectiveOutcome: decision.effectiveOutcome,
      reason: decision.reason,
    },
  });
}

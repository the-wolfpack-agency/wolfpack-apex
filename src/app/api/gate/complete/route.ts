/**
 * POST /api/gate/complete
 *
 * An outside agent's REASONING, run through our model router.
 *
 * WHAT WAS MISSING, and it is a sharper distinction than the gate alone.
 *
 * /api/gate/authorize is reactive. An external agent decides to act, asks
 * whether it may, and we answer. We authorize it. We do not drive it, and its
 * thinking happens somewhere we cannot see: their model, their provider, their
 * bill, their data leaving through a door we never inspected.
 *
 * This is the other direction. A third-party agent sends us the completion it
 * was about to make, and it runs through the same router every internal call
 * uses. That means the controls apply to somebody else's agent:
 *
 *   redaction        credentials and identifiers stripped on the way out, and
 *                    the answer checked the same way coming back
 *   residency        refuses a model whose region is undeclared
 *   retention        restricted to providers that keep nothing
 *   content policy   claims the business cannot stand behind are withheld
 *   budget           tier clamped under pressure, refused at the ceiling
 *   ledger           what was asked, what it cost, which rule applied
 *
 * A client keeps the agents they already run and gets our governance and our
 * cost routing underneath them. That is the argument, and it only holds
 * because the router is a genuine chokepoint rather than a wrapper.
 *
 * THE KEY DECIDES THE TIER CEILING, NOT THE CALLER. An external agent asking
 * for the premium model on every call would be spending our money on their
 * reasoning. The request may ask for a tier and the router may clamp it, which
 * is the same treatment internal callers get.
 *
 * CAPABILITY SCOPED, like every other external call. A key that may not read
 * the Brain may not ask a model to reason about it either, so the same
 * allowlist that gates actions gates inference.
 *
 * Status discipline mirrors /api/gate/authorize: a refusal by policy is a
 * served 200 carrying `allowed: false`, never a 403. The HTTP status reports
 * whether we served the query; the verdict lives in the body.
 */

import { NextRequest, NextResponse } from "next/server";
import { verifyApiKey } from "@/lib/ogiam/api-keys";
import { checkRateLimit } from "@/lib/ogiam/gate-rate-limit";
import { getAIClient } from "@/lib/ai/router";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const AUTH_FAILED = "authentication failed";

/** The capability an external agent must hold to have us think for it. */
const INFERENCE_CAPABILITY = "ai.complete";

/** Bounded so one caller cannot buy an essay on our account. */
const MAX_TOKENS = 2048;
const MAX_PROMPT_CHARS = 24_000;

interface CompleteBody {
  prompt?: unknown;
  system?: unknown;
  max_tokens?: unknown;
  tier?: unknown;
  residency?: unknown;
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  /* 1. AUTH. Generic 401 on any failure: not_found, revoked and malformed are
        recorded internally and never distinguished to the caller, so a probe
        cannot learn which keys exist. */
  const authHeader = req.headers.get("authorization") ?? "";
  const rawKey = authHeader.startsWith("Bearer ")
    ? authHeader.slice("Bearer ".length).trim()
    : "";
  const key = rawKey
    ? await verifyApiKey(rawKey)
    : ({ ok: false, reason: "malformed" } as const);

  if (!key.ok) {
    trackEvent("platform.gate_api_blocked", "external_agent", "external_agent", {
      reason: "auth_failed",
      detail: key.reason,
      surface: "complete",
    });
    return NextResponse.json({ error: AUTH_FAILED }, { status: 401 });
  }

  /* 2. RATE LIMIT. Inference costs money, so the per-key budget matters more
        here than on an authorization query. */
  const rl = await checkRateLimit(key.id);
  if (!rl.ok) {
    trackEvent("platform.gate_api_blocked", `apikey:${key.id}`, "external_agent", {
      reason: "rate_limited",
      agent: key.agent,
      surface: "complete",
    });
    return NextResponse.json(
      { error: "rate limit exceeded" },
      { status: 429, headers: { "Retry-After": "60" } },
    );
  }

  /* 3. SCOPE. The same allowlist that gates actions gates inference: a key
        that may not read the Brain may not ask a model to reason about it. */
  if (!key.capabilities.includes(INFERENCE_CAPABILITY)) {
    trackEvent("platform.gate_api_blocked", `apikey:${key.id}`, "external_agent", {
      reason: "capability_out_of_scope",
      agent: key.agent,
      surface: "complete",
    });
    return NextResponse.json(
      { allowed: false, reason: "capability_out_of_scope" },
      { status: 200 },
    );
  }

  let body: CompleteBody;
  try {
    body = (await req.json()) as CompleteBody;
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "body must be JSON" },
      { status: 400 },
    );
  }

  const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
  if (!prompt) {
    return NextResponse.json(
      { error: "invalid_input", detail: "prompt is required" },
      { status: 400 },
    );
  }
  if (prompt.length > MAX_PROMPT_CHARS) {
    return NextResponse.json(
      { error: "invalid_input", detail: `prompt may be at most ${MAX_PROMPT_CHARS} characters` },
      { status: 400 },
    );
  }

  /* Clamped rather than trusted. An agent asking for more than we allow gets
     our ceiling, not an error, because failing a long request is worse for the
     caller than answering it briefly. */
  const requested = Number(body.max_tokens);
  const maxTokens = Number.isFinite(requested)
    ? Math.max(1, Math.min(MAX_TOKENS, Math.floor(requested)))
    : 512;

  /* Cheap unless asked otherwise, and never premium. An external caller
     choosing the expensive model on every call would be spending our money on
     their reasoning; the router may clamp this further under budget pressure. */
  const tier = body.tier === "standard" ? "standard" : "cheap";

  const residency = Array.isArray(body.residency)
    ? body.residency.filter((r): r is string => typeof r === "string")
    : undefined;

  try {
    const client = getAIClient();
    const response = await client.complete({
      messages: [{ role: "user", content: prompt }],
      ...(typeof body.system === "string" && body.system.trim()
        ? { system: body.system.trim() }
        : {}),
      max_tokens: maxTokens,
      model_tier: tier,
      ...(residency && residency.length > 0 ? { residency } : {}),
      /* The constitution applies to an outside agent for the same reason it
         applies to ours: the rules are about the answer, not about who asked. */
      apply_constitution: true,
      metadata: {
        feature: "gate.external_agent",
        user_id: `apikey:${key.id}`,
        user_role: "external_agent",
        workspace_id: key.workspaceId,
        routing_reason: "external_agent_inference",
      },
    });

    trackEvent("platform.gate_api_completed", `apikey:${key.id}`, "external_agent", {
      agent: key.agent,
      surface: "complete",
      workspace_id: key.workspaceId,
      tier_requested: tier,
      model_used: response.model_used,
      provider_used: response.provider_used,
    });

    return NextResponse.json(
      {
        allowed: true,
        content: response.content,
        /* Told, not hidden. An agent that knows which model answered can
           decide whether to trust the answer, and a client can see that their
           agent's reasoning was routed rather than sent straight to a vendor. */
        model: response.model_used,
        provider: response.provider_used,
      },
      { status: 200, headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    /* A refusal by the router (residency, retention, budget ceiling) is a
       served verdict rather than a broken request, and reads as allowed:false
       exactly like a policy deny on the authorize route. */
    const detail = err instanceof Error ? err.message : "the request could not be completed";
    trackEvent("platform.gate_api_blocked", `apikey:${key.id}`, "external_agent", {
      reason: "router_refused",
      agent: key.agent,
      surface: "complete",
      detail: detail.slice(0, 200),
    });
    return NextResponse.json({ allowed: false, reason: "router_refused", detail }, { status: 200 });
  }
}

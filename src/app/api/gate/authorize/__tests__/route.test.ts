/**
 * Contract for POST /api/gate/authorize (the bring-your-own-agent gate).
 *
 * verifyApiKey, the rate limiter, the OGIAM gate, and analytics are all mocked,
 * so no DB / network is touched. The key contracts under test:
 *   - valid key + in-scope capability + gate allow  -> 200 { allowed: true }
 *   - gate deny-by-policy                            -> 200 { allowed: false } (NOT 403)
 *   - missing / malformed / not-found / revoked key  -> 401 (generic message)
 *   - capability not in the key's scope              -> 403, gate NEVER consulted
 *   - over rate-limit budget                         -> 429, gate NEVER consulted
 *   - missing body fields                            -> 400
 *   - params are NEVER echoed back in the response
 *   - the right analytics event fires on every branch
 */
const mockVerify = jest.fn();
const mockCheckRateLimit = jest.fn();
const mockAuthorize = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/ogiam/api-keys", () => ({
  verifyApiKey: (...a: unknown[]) => mockVerify(...a),
}));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockCheckRateLimit(...a),
}));
jest.mock("@/lib/ogiam/authorize", () => ({
  authorize: (...a: unknown[]) => mockAuthorize(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrack(...a),
}));

import { NextRequest } from "next/server";
import { POST } from "@/app/api/gate/authorize/route";

const VALID_KEY = {
  ok: true as const,
  id: "key-1",
  workspaceId: "ws-1",
  agent: "acme-bot",
  capabilities: ["mail.read", "calendar.write"],
};

const ALLOW_DECISION = {
  intendedOutcome: "allow",
  effectiveOutcome: "allow",
  enforced: true,
  mode: "enforce",
  riskTier: "low",
  policyVersion: "v1",
  ruleId: "rule-allow",
  reason: "within policy",
  wouldBlock: false,
  recordedSeq: 42,
};

const DENY_DECISION = {
  ...ALLOW_DECISION,
  intendedOutcome: "deny",
  effectiveOutcome: "deny",
  ruleId: "rule-deny",
  reason: "mutation blocked by policy",
  wouldBlock: true,
};

const SECRET_PARAMS = { ssn: "123-45-6789", to: "victim@example.com" };

function post(body: unknown, headers: Record<string, string> = {}) {
  return POST(
    new NextRequest("http://localhost/api/gate/authorize", {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const BEARER = { authorization: "Bearer raw-key-abc" };
const IN_SCOPE_BODY = {
  tool: "send_mail",
  capability: "mail.read",
  isMutation: false,
  params: SECRET_PARAMS,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockResolvedValue(VALID_KEY);
  mockCheckRateLimit.mockResolvedValue({ ok: true, remaining: 119 });
  mockAuthorize.mockResolvedValue(ALLOW_DECISION);
});

describe("happy path", () => {
  it("200 { allowed: true } for a valid key, in-scope capability, gate allow + fires gate_api_authorized", async () => {
    const res = await post(IN_SCOPE_BODY, BEARER);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      allowed: true,
      decision: {
        ruleId: "rule-allow",
        effectiveOutcome: "allow",
        reason: "within policy",
      },
    });
    expect(mockVerify).toHaveBeenCalledWith("raw-key-abc");
    expect(mockAuthorize).toHaveBeenCalledWith(
      expect.objectContaining({
        principal: {
          kind: "ai_agent",
          agent: "acme-bot",
          onBehalfOfUserId: "apikey:key-1",
          onBehalfOfRole: "external_agent",
          workspaceId: "ws-1",
        },
        tool: "send_mail",
        capability: "mail.read",
        isMutation: false,
        surface: "/external",
        mode: "enforce",
      }),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.gate_api_authorized",
      "apikey:key-1",
      "external_agent",
      expect.objectContaining({ agent: "acme-bot", tool: "send_mail", outcome: "allow" }),
    );
  });

  it("200 { allowed: false } when the gate DENIES by policy (a deny is NOT a 403) + still fires gate_api_authorized", async () => {
    mockAuthorize.mockResolvedValue(DENY_DECISION);
    const res = await post(
      { tool: "send_mail", capability: "calendar.write", isMutation: true },
      BEARER,
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.allowed).toBe(false);
    expect(json.decision).toEqual({
      ruleId: "rule-deny",
      effectiveOutcome: "deny",
      reason: "mutation blocked by policy",
    });
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.gate_api_authorized",
      "apikey:key-1",
      "external_agent",
      expect.objectContaining({ outcome: "deny" }),
    );
  });

  it("NEVER echoes the caller's params back in the response (no secret leak)", async () => {
    const res = await post(IN_SCOPE_BODY, BEARER);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("123-45-6789");
    expect(text).not.toContain("victim@example.com");
    expect(text).not.toContain("ssn");
    // And the decision summary carries only the explainability fields.
    const json = JSON.parse(text);
    expect(Object.keys(json.decision).sort()).toEqual([
      "effectiveOutcome",
      "reason",
      "ruleId",
    ]);
    expect(json.decision).not.toHaveProperty("recordedSeq");
  });
});

describe("auth failures (generic 401, never reveal which part failed)", () => {
  it("401 when no Authorization header is present (gate never consulted)", async () => {
    const res = await post(IN_SCOPE_BODY); // no bearer
    expect(res.status).toBe(401);
    expect(mockVerify).not.toHaveBeenCalled();
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.gate_api_blocked",
      "external_agent",
      "external_agent",
      expect.objectContaining({ reason: "auth_failed" }),
    );
  });

  it("401 when verifyApiKey reports not_found", async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await post(IN_SCOPE_BODY, BEARER);
    expect(res.status).toBe(401);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("401 when the key is revoked (same generic message as not_found/malformed)", async () => {
    mockVerify.mockResolvedValue({ ok: false, reason: "revoked" });
    const res = await post(IN_SCOPE_BODY, BEARER);
    expect(res.status).toBe(401);
    const notFoundRes = await (async () => {
      mockVerify.mockResolvedValue({ ok: false, reason: "not_found" });
      return post(IN_SCOPE_BODY, BEARER);
    })();
    // The body must not differentiate the cause.
    expect(await res.json()).toEqual(await notFoundRes.json());
    expect(mockAuthorize).not.toHaveBeenCalled();
  });
});

describe("rate limiting", () => {
  it("429 when the key is over its budget (gate never consulted) + fires gate_api_blocked", async () => {
    mockCheckRateLimit.mockResolvedValue({ ok: false, remaining: 0 });
    const res = await post(IN_SCOPE_BODY, BEARER);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("60");
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.gate_api_blocked",
      "apikey:key-1",
      "external_agent",
      expect.objectContaining({ reason: "rate_limited" }),
    );
  });
});

describe("scope enforcement (defense in depth on top of the gate)", () => {
  it("403 capability_out_of_scope when the capability is not granted to the key; gate NEVER consulted", async () => {
    const res = await post(
      { tool: "delete_user", capability: "admin.delete" },
      BEARER,
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      allowed: false,
      reason: "capability_out_of_scope",
    });
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.gate_api_blocked",
      "apikey:key-1",
      "external_agent",
      expect.objectContaining({ reason: "out_of_scope", capability: "admin.delete" }),
    );
  });
});

describe("body validation", () => {
  it("400 when tool is missing", async () => {
    const res = await post({ capability: "mail.read" }, BEARER);
    expect(res.status).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("400 when capability is missing", async () => {
    const res = await post({ tool: "send_mail" }, BEARER);
    expect(res.status).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON (rate limit already passed, so it fires bad_request)", async () => {
    const res = await post("{not json", BEARER);
    expect(res.status).toBe(400);
    expect(mockAuthorize).not.toHaveBeenCalled();
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.gate_api_blocked",
      "apikey:key-1",
      "external_agent",
      expect.objectContaining({ reason: "bad_request" }),
    );
  });
});

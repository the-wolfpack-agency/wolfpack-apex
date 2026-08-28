/**
 * An outside agent's reasoning, run through our model router.
 *
 * /api/gate/authorize is reactive: an external agent decides to act, asks
 * whether it may, and we answer. Its THINKING happens somewhere we cannot see,
 * on its model, its provider, its bill, with its data leaving through a door
 * we never inspected.
 *
 * This is the other direction, and it is the one that matters as models need
 * less vendor-specific prompting. When the instructions stop being the
 * differentiator, the layer that applies consistent rules across whichever
 * model answers becomes the product. That layer is the router, and these
 * assertions are about it applying to somebody else's agent exactly as it
 * applies to ours.
 */
const mockVerify = jest.fn();
const mockRateLimit = jest.fn();
const mockComplete = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/ogiam/api-keys", () => ({ verifyApiKey: (...a: unknown[]) => mockVerify(...a) }));
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));
jest.mock("@/lib/ai/router", () => ({ getAIClient: () => ({ complete: mockComplete }) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { POST } from "@/app/api/gate/complete/route";

const req = (body: unknown, auth = "Bearer ogk_valid") =>
  ({
    headers: new Headers({ authorization: auth }),
    json: async () => body,
    url: "https://wolfpack-instinct.vercel.app/api/gate/complete",
  }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  mockVerify.mockResolvedValue({
    ok: true,
    id: "k1",
    workspaceId: "ws1",
    agent: "acme.qa-bot",
    capabilities: ["ai.complete"],
  });
  mockRateLimit.mockResolvedValue({ ok: true });
  mockComplete.mockResolvedValue({
    content: "the answer",
    model_used: "gpt-4o-mini",
    provider_used: "azure_openai",
  });
});

describe("who may ask", () => {
  it.each([
    ["no header", ""],
    ["not a bearer", "Basic abc"],
    ["empty bearer", "Bearer "],
  ])("refuses %s", async (_label, auth) => {
    mockVerify.mockResolvedValue({ ok: false, reason: "malformed" });
    expect((await POST(req({ prompt: "hi" }, auth))).status).toBe(401);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  /* A probe must not learn which keys exist, so revoked and unknown look
     identical from outside. */
  it("does not distinguish a revoked key from an unknown one", async () => {
    const bodies: unknown[] = [];
    for (const reason of ["revoked", "not_found"]) {
      mockVerify.mockResolvedValue({ ok: false, reason });
      const res = await POST(req({ prompt: "hi" }));
      expect(res.status).toBe(401);
      bodies.push(await res.json());
    }
    expect(bodies[0]).toEqual(bodies[1]);
  });

  /* Inference costs money, so the per-key budget matters more here than on an
     authorization query. */
  it("refuses over the rate limit", async () => {
    mockRateLimit.mockResolvedValue({ ok: false });
    const res = await POST(req({ prompt: "hi" }));
    expect(res.status).toBe(429);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  /* The same allowlist that gates actions gates inference: a key that may not
     read the Brain may not ask a model to reason about it either. */
  it("refuses a key without the inference capability", async () => {
    mockVerify.mockResolvedValue({
      ok: true, id: "k1", workspaceId: "ws1", agent: "a", capabilities: ["brain.read"],
    });
    const res = await POST(req({ prompt: "hi" }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      allowed: false,
      reason: "capability_out_of_scope",
    });
    expect(mockComplete).not.toHaveBeenCalled();
  });
});

describe("what it will spend", () => {
  /* An external caller choosing the expensive model on every call would be
     spending our money on their reasoning. */
  it("never routes an external agent to the premium tier", async () => {
    await POST(req({ prompt: "hi", tier: "premium" }));
    expect(mockComplete).toHaveBeenCalledWith(
      expect.objectContaining({ model_tier: "cheap" }),
    );
  });

  it("allows standard when asked, and defaults to cheap", async () => {
    await POST(req({ prompt: "hi", tier: "standard" }));
    expect(mockComplete.mock.calls[0][0].model_tier).toBe("standard");

    mockComplete.mockClear();
    await POST(req({ prompt: "hi" }));
    expect(mockComplete.mock.calls[0][0].model_tier).toBe("cheap");
  });

  /* Clamped rather than rejected: failing a long request is worse for the
     caller than answering it briefly. */
  it("clamps an oversized token request instead of failing it", async () => {
    const res = await POST(req({ prompt: "hi", max_tokens: 999_999 }));
    expect(res.status).toBe(200);
    expect(mockComplete.mock.calls[0][0].max_tokens).toBe(2048);
  });

  it("refuses a prompt beyond the size ceiling", async () => {
    const res = await POST(req({ prompt: "x".repeat(24_001) }));
    expect(res.status).toBe(400);
    expect(mockComplete).not.toHaveBeenCalled();
  });

  it("requires a prompt at all", async () => {
    expect((await POST(req({}))).status).toBe(400);
    expect((await POST(req({ prompt: "   " }))).status).toBe(400);
  });
});

describe("the controls that make this worth doing", () => {
  /* THE POINT OF THE ENDPOINT. As models need less vendor-specific prompting,
     the rules have to live somewhere model-agnostic. The constitution is
     applied at the router rather than baked into one vendor's prompt format,
     so it travels with the request whichever model answers. */
  it("applies the operating rules to an outside agent's reasoning", async () => {
    await POST(req({ prompt: "hi" }));
    expect(mockComplete.mock.calls[0][0].apply_constitution).toBe(true);
  });

  it("passes a residency requirement through to the router", async () => {
    await POST(req({ prompt: "hi", residency: ["eu"] }));
    expect(mockComplete.mock.calls[0][0].residency).toEqual(["eu"]);
  });

  it("states no residency requirement when none was given, rather than inventing one", async () => {
    await POST(req({ prompt: "hi" }));
    expect(mockComplete.mock.calls[0][0].residency).toBeUndefined();
  });

  /* Cost and audit attribute to the key and its workspace, not to a person
     who was never involved. */
  it("attributes the spend to the calling key and its workspace", async () => {
    await POST(req({ prompt: "hi" }));
    expect(mockComplete.mock.calls[0][0].metadata).toMatchObject({
      user_id: "apikey:k1",
      user_role: "external_agent",
      workspace_id: "ws1",
      feature: "gate.external_agent",
    });
  });
});

describe("the answer", () => {
  it("returns the content and says which model produced it", async () => {
    const res = await POST(req({ prompt: "hi" }));
    await expect(res.json()).resolves.toMatchObject({
      allowed: true,
      content: "the answer",
      model: "gpt-4o-mini",
      provider: "azure_openai",
    });
  });

  /* A refusal by the router is a served verdict, exactly like a policy deny on
     the authorize route. A 500 would read as our outage rather than as their
     request being refused. */
  it("returns a router refusal as a served verdict, not an error", async () => {
    mockComplete.mockRejectedValue(new Error("no model satisfies residency ['eu']"));
    const res = await POST(req({ prompt: "hi", residency: ["eu"] }));
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({
      allowed: false,
      reason: "router_refused",
    });
  });

  it("records what an external agent's reasoning cost us", async () => {
    await POST(req({ prompt: "hi" }));
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.gate_api_completed",
      "apikey:k1",
      "external_agent",
      expect.objectContaining({ agent: "acme.qa-bot", model_used: "gpt-4o-mini" }),
    );
  });
});

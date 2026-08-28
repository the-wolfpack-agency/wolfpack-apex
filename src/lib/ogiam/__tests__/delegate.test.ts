/**
 * Handing a task to an external agent.
 *
 * /api/gate/authorize is reactive: their agent decides to act and asks whether
 * it may. /api/gate/complete runs its reasoning through our router. Both are
 * things the agent starts. Neither lets us give it work, and that is the
 * difference between governing an agent and leading one.
 *
 * Sending a request to a stored URL is server-side request forgery waiting to
 * happen, so most of what is asserted here is about refusing to send.
 */
const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import {
  delegateTask,
  delegationSignature,
  verifyDelegationSignature,
} from "@/lib/ogiam/delegate";

const target = {
  keyId: "k1",
  workspaceId: "ws1",
  agent: "acme.qa-bot",
  delegationUrl: "https://agent.example.com/tasks",
  capabilities: ["brain.read"],
};

const SECRET = "the-agents-key-hash";

const ok = () =>
  new Response(JSON.stringify({ accepted: true }), { status: 200 });

const deps = (over: Record<string, unknown> = {}) => ({
  fetchImpl: jest.fn(async () => ok()),
  assertUrl: jest.fn(async () => undefined),
  now: () => 1_700_000_000_000,
  ...over,
});

const call = (over: Record<string, unknown> = {}) => ({
  target,
  instruction: "Review the onboarding docs and list what is missing",
  signingSecret: SECRET,
  actor: { userId: "u1", role: "cto" },
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("refusing to send", () => {
  it("will not deliver to an agent with no endpoint", async () => {
    const d = deps();
    const out = await delegateTask(
      call({ target: { ...target, delegationUrl: null } }),
      d as never,
    );
    expect(out.delivered).toBe(false);
    expect(out.refused).toMatch(/no delegation endpoint/i);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });

  /* A hostname that was public at registration can point at an internal
     address by the time we send, so the guard has to run at dispatch. */
  it("re-validates the endpoint at dispatch rather than trusting storage", async () => {
    const d = deps();
    await delegateTask(call(), d as never);
    expect(d.assertUrl).toHaveBeenCalledWith("https://agent.example.com/tasks");
  });

  it("does not send when the guard blocks the endpoint", async () => {
    const d = deps({
      assertUrl: jest.fn(async () => {
        throw new Error("host resolves to a private IP (169.254.169.254)");
      }),
    });
    const out = await delegateTask(call(), d as never);

    expect(out.delivered).toBe(false);
    expect(d.fetchImpl).not.toHaveBeenCalled();
    /* The operator is told it was refused, without the internal address being
       echoed back to them. */
    expect(out.refused).not.toContain("169.254");
  });

  /* The SSRF guard permits http for scanning a site. Delivery is different: an
     instruction somebody will act on must not be readable or rewritable in
     transit. */
  it("requires https, even though the guard allows http", async () => {
    const d = deps();
    const out = await delegateTask(
      call({ target: { ...target, delegationUrl: "http://agent.example.com/tasks" } }),
      d as never,
    );
    expect(out.delivered).toBe(false);
    expect(out.refused).toMatch(/https/i);
    expect(d.fetchImpl).not.toHaveBeenCalled();
  });
});

describe("what travels", () => {
  /* NO CREDENTIAL LEAVES. The agent proves who it is by calling US back with
     its own key. We never hand it one, and never one of ours. */
  it("sends no secret of any kind", async () => {
    const d = deps();
    await delegateTask(call(), d as never);

    const [, init] = (d.fetchImpl as jest.Mock).mock.calls[0];
    const sent = JSON.stringify({ body: init.body, headers: init.headers });
    expect(sent).not.toContain(SECRET);
    expect(sent).not.toMatch(/authorization/i);
  });

  it("names the task, the workspace and where to come back to", async () => {
    const d = deps();
    await delegateTask(call(), d as never);

    const body = JSON.parse((d.fetchImpl as jest.Mock).mock.calls[0][1].body);
    expect(body).toMatchObject({
      workspace_id: "ws1",
      agent: "acme.qa-bot",
      instruction: "Review the onboarding docs and list what is missing",
      gate: "/api/gate/authorize",
    });
  });

  /* So the receiving agent can tell a real assignment from anyone who learned
     its endpoint. */
  it("signs the delivery over the body and a timestamp", async () => {
    const d = deps();
    await delegateTask(call(), d as never);

    const [, init] = (d.fetchImpl as jest.Mock).mock.calls[0];
    const ts = Number(init.headers["X-Instinct-Timestamp"]);
    expect(
      verifyDelegationSignature(SECRET, init.body, ts, init.headers["X-Instinct-Signature"]),
    ).toBe(true);
  });

  it("produces a signature that fails against a different secret", async () => {
    const body = '{"a":1}';
    const sig = delegationSignature(SECRET, body, 123);
    expect(verifyDelegationSignature("someone-elses-secret", body, 123, sig)).toBe(false);
  });

  /* A replayed body under a different timestamp must not verify, or the
     signature says nothing about when it was issued. */
  it("produces a signature that fails against a different timestamp", async () => {
    const body = '{"a":1}';
    const sig = delegationSignature(SECRET, body, 123);
    expect(verifyDelegationSignature(SECRET, body, 124, sig)).toBe(false);
  });

  it("rejects a malformed signature without throwing", () => {
    expect(verifyDelegationSignature(SECRET, "{}", 1, "short")).toBe(false);
    expect(verifyDelegationSignature(SECRET, "{}", 1, "")).toBe(false);
  });
});

describe("what comes back", () => {
  it("reports a delivered task", async () => {
    const out = await delegateTask(call(), deps() as never);
    expect(out.delivered).toBe(true);
    expect(out.status).toBe(200);
  });

  it("reports a refusal by the agent as not delivered", async () => {
    const d = deps({
      fetchImpl: jest.fn(async () => new Response("busy", { status: 503 })),
    });
    const out = await delegateTask(call(), d as never);
    expect(out.delivered).toBe(false);
    expect(out.status).toBe(503);
    expect(out.refused).toMatch(/did not accept/i);
  });

  it("reports an unreachable agent without throwing", async () => {
    const d = deps({
      fetchImpl: jest.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const out = await delegateTask(call(), d as never);
    expect(out.delivered).toBe(false);
    expect(out.refused).toMatch(/could not be reached/i);
  });

  it("reports a timeout as a timeout, not as a refusal", async () => {
    const abort = Object.assign(new Error("aborted"), { name: "AbortError" });
    const d = deps({
      fetchImpl: jest.fn(async () => {
        throw abort;
      }),
    });
    const out = await delegateTask(call(), d as never);
    expect(out.refused).toMatch(/did not answer within/i);
  });

  /* A report to be read by a person, not a payload to be trusted. */
  it("bounds what the agent can send back", async () => {
    const d = deps({
      fetchImpl: jest.fn(async () => new Response("x".repeat(50_000), { status: 200 })),
    });
    const out = await delegateTask(call(), d as never);
    expect(out.report!.length).toBe(20_000);
  });

  it("records the delivery against the agent's key", async () => {
    await delegateTask(call(), deps() as never);
    expect(mockTrack).toHaveBeenCalledWith(
      "platform.gate_api_delegated",
      "apikey:k1",
      "external_agent",
      expect.objectContaining({ agent: "acme.qa-bot", accepted: true }),
    );
  });
});

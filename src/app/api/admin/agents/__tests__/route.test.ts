/**
 * Contract tests for the agent principals collection API.
 *
 *   POST /api/admin/agents: create/invite an agent (201 + one-time secret + audit;
 *     401 / 403 gate; 400 on bad input; 403 on a lower admin minting a top-privilege
 *     agent; 409 on a name conflict).
 *   GET /api/admin/agents: list the workspace's agents (200 shape).
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockCreateAgent = jest.fn();
const mockListAgents = jest.fn();
jest.mock("@/lib/agents/store", () => ({
  createAgent: (...a: any[]) => mockCreateAgent(...a),
  listAgents: (...a: any[]) => mockListAgents(...a),
}));

const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: any[]) => mockRecordAudit(...a),
  extractRequestMetadata: () => ({}),
}));

const mockSendAgentInviteEmail = jest.fn();
jest.mock("@/lib/agents/invite-email", () => ({
  sendAgentInviteEmail: (...a: any[]) => mockSendAgentInviteEmail(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };
const OPS = { id: "u_ops", email: "ops@x.com", role: "ops", workspaceId: "ws_1" };

function mkReq(body: unknown): any {
  return {
    url: "http://x/api/admin/agents",
    headers: new Headers(),
    json: async () => body,
  };
}

const SAMPLE_AGENT = {
  id: "a_1",
  workspaceId: "default",
  name: "Researcher",
  role: "ops",
  ownerUserId: "u_cto",
  state: "invited",
  identityProvider: "local",
  externalSubject: null,
  scanStatus: "pending",
  description: null,
  createdBy: "u_cto",
  createdAt: "2026-06-19T00:00:00.000Z",
  activatedAt: null,
  lastSeenAt: null,
  revokedAt: null,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRecordAudit.mockResolvedValue({ id: "audit_1", seq: 1, entryHash: "h" });
  mockSendAgentInviteEmail.mockResolvedValue({ ok: true });
});

describe("POST /api/admin/agents", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "ops" }));
    expect(res.status).toBe(401);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "ops" }));
    expect(res.status).toBe(403);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("201 returns agent + one-time onboarding_secret and records an audit entry", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({
      agent: SAMPLE_AGENT,
      onboardingSecret: "deadbeef".repeat(8),
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(
      mkReq({ name: "Researcher", role: "ops", description: "reads papers" }),
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      agent: { id: string };
      onboarding_secret: string;
    };
    expect(body.agent.id).toBe("a_1");
    expect(body.onboarding_secret).toBe("deadbeef".repeat(8));

    // owner defaults to the caller and workspace comes off the caller.
    const arg = mockCreateAgent.mock.calls[0][0];
    expect(arg.ownerUserId).toBe("u_cto");
    expect(arg.workspaceId).toBe("default");
    expect(arg.createdBy).toBe("u_cto");

    // Minting a principal is a capability grant: it is hash-chained.
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const audit = mockRecordAudit.mock.calls[0][0];
    expect(audit.action).toBe("agent.created");
    expect(audit.resourceType).toBe("agent");
    expect(audit.resourceId).toBe("a_1");
    expect(audit.afterState).toMatchObject({
      role: "ops",
      owner_user_id: "u_cto",
      identity_provider: "local",
    });
  });

  it("uses owner_user_id from the body when provided", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({ agent: SAMPLE_AGENT, onboardingSecret: "x" });
    const { POST } = await import("@/app/api/admin/agents/route");
    await POST(mkReq({ name: "Researcher", role: "ops", owner_user_id: "u_owner" }));
    expect(mockCreateAgent.mock.calls[0][0].ownerUserId).toBe("u_owner");
  });

  it("400 on an invalid role", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "wizard" }));
    expect(res.status).toBe(400);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("400 on an empty name", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "   ", role: "ops" }));
    expect(res.status).toBe(400);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("403 when a non-cto/ceo admin tries to mint a cto agent", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: OPS });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Overlord", role: "cto" }));
    expect(res.status).toBe(403);
    expect(mockCreateAgent).not.toHaveBeenCalled();
  });

  it("allows a cto to mint a cto agent", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({
      agent: { ...SAMPLE_AGENT, role: "cto" },
      onboardingSecret: "x",
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Overlord", role: "cto" }));
    expect(res.status).toBe(201);
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
  });

  it("with inviteEmail: sends the invite email, tracks agent.invite_emailed, and still returns the secret", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({
      agent: SAMPLE_AGENT,
      onboardingSecret: "deadbeef".repeat(8),
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(
      mkReq({
        name: "Researcher",
        role: "ops",
        inviteEmail: "operator@thewolfpack.agency",
      }),
    );
    expect(res.status).toBe(201);

    // Creation still happened and the one-time secret is STILL returned —
    // the email is an addition, not a replacement.
    expect(mockCreateAgent).toHaveBeenCalledTimes(1);
    const body = (await res.json()) as { onboarding_secret: string };
    expect(body.onboarding_secret).toBe("deadbeef".repeat(8));

    // The invite email was sent with the to-address, the secret, and an
    // activation URL pointing at this agent.
    expect(mockSendAgentInviteEmail).toHaveBeenCalledTimes(1);
    const mail = mockSendAgentInviteEmail.mock.calls[0][0];
    expect(mail.to).toBe("operator@thewolfpack.agency");
    expect(mail.agentId).toBe("a_1");
    expect(mail.onboardingSecret).toBe("deadbeef".repeat(8));
    expect(mail.activationUrl).toContain("/agents/activate?agent=a_1");
    expect(mail.invitedByRole).toBe("cto");

    // On a successful send, the event fires.
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.invite_emailed",
      "u_cto",
      "cto",
      { agent_id: "a_1" },
    );
  });

  it("does NOT track agent.invite_emailed when the email fails to send (creation still succeeds)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({ agent: SAMPLE_AGENT, onboardingSecret: "x" });
    mockSendAgentInviteEmail.mockResolvedValue({ ok: false });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(
      mkReq({ name: "Researcher", role: "ops", inviteEmail: "operator@x.com" }),
    );
    expect(res.status).toBe(201);
    expect(mockSendAgentInviteEmail).toHaveBeenCalledTimes(1);
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "agent.invite_emailed",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("without inviteEmail: no email sent, no event, creation still succeeds (no regression)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({
      agent: SAMPLE_AGENT,
      onboardingSecret: "deadbeef".repeat(8),
    });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "ops" }));
    expect(res.status).toBe(201);
    const body = (await res.json()) as { onboarding_secret: string };
    expect(body.onboarding_secret).toBe("deadbeef".repeat(8));
    expect(mockSendAgentInviteEmail).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "agent.invite_emailed",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("ignores a malformed inviteEmail (no send, no event, still 201)", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({ agent: SAMPLE_AGENT, onboardingSecret: "x" });
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(
      mkReq({ name: "Researcher", role: "ops", inviteEmail: "not-an-email" }),
    );
    expect(res.status).toBe(201);
    expect(mockSendAgentInviteEmail).not.toHaveBeenCalled();
  });

  it("rejects an over-long inviteEmail in bounded time (no ReDoS)", async () => {
    // Regression: EMAIL_RE's alternatives overlap, so a long adversarial
    // string drove it to polynomial time (CodeQL: js/polynomial-redos). The
    // length cap must short-circuit BEFORE .test() ever runs.
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({ agent: SAMPLE_AGENT, onboardingSecret: "x" });
    const { POST } = await import("@/app/api/admin/agents/route");

    // Picking the witness is fiddly, so it is spelled out here:
    //  - [^\s@]+ eats dots, so the shape CodeQL suggested ("!@" + "!." xN)
    //    actually MATCHES and returns in ~1ms. It proves nothing.
    //  - The match must FAIL for the engine to backtrack over every ".", so
    //    [^\s@]+$ needs a space it cannot cross.
    //  - The space cannot be trailing: the route .trim()s first, which would
    //    hand the regex a fast-matching string again.
    // Hence an INTERNAL space after the last dot. Measured without the cap:
    // 20k chars 149ms, 40k 578ms, 80k 2308ms — quadratic.
    const evil = "a@" + "a.".repeat(40_000) + "x y";
    const started = Date.now();
    const res = await POST(
      mkReq({ name: "Researcher", role: "ops", inviteEmail: evil }),
    );
    const elapsed = Date.now() - started;

    // Creation still succeeds; the bad address is simply ignored.
    expect(res.status).toBe(201);
    expect(mockSendAgentInviteEmail).not.toHaveBeenCalled();
    // Unbounded, this input takes many seconds; capped, it is effectively free.
    expect(elapsed).toBeLessThan(1000);
  });

  it("accepts an inviteEmail at the 254-char RFC-5321 limit", async () => {
    // The cap must not reject a legal address.
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockResolvedValue({ agent: SAMPLE_AGENT, onboardingSecret: "x" });
    mockSendAgentInviteEmail.mockResolvedValue({ ok: true });
    const { POST } = await import("@/app/api/admin/agents/route");

    const local = "a".repeat(249); // 249 + "@" (1) + "b.co" (4) = 254 exactly
    const maxLen = `${local}@b.co`;
    expect(maxLen).toHaveLength(254);

    const res = await POST(
      mkReq({ name: "Researcher", role: "ops", inviteEmail: maxLen }),
    );
    expect(res.status).toBe(201);
    expect(mockSendAgentInviteEmail).toHaveBeenCalledTimes(1);
    expect(mockSendAgentInviteEmail.mock.calls[0][0].to).toBe(maxLen);
  });

  it("409 when the agent name is already taken in the workspace", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockCreateAgent.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "instinct_agents_ws_name"'),
    );
    const { POST } = await import("@/app/api/admin/agents/route");
    const res = await POST(mkReq({ name: "Researcher", role: "ops" }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe("name_taken");
  });
});

describe("GET /api/admin/agents", () => {
  it("403 without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { GET } = await import("@/app/api/admin/agents/route");
    const res = await GET(mkReq({}));
    expect(res.status).toBe(403);
    expect(mockListAgents).not.toHaveBeenCalled();
  });

  it("200 returns the workspace's agents", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    mockListAgents.mockResolvedValue([SAMPLE_AGENT]);
    const { GET } = await import("@/app/api/admin/agents/route");
    const res = await GET(mkReq({}));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { agents: Array<{ id: string }> };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].id).toBe("a_1");
    // workspace-scoped to the caller.
    expect(mockListAgents).toHaveBeenCalledWith("default");
  });
});

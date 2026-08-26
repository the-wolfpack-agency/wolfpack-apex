/**
 * Probing the quiet integrations, from where the credentials actually are.
 *
 * The contract that matters is the refusal. A probe run without a live token
 * fails every surface for one irrelevant reason, and a table of those failures
 * reads as broken integrations to anybody scanning it. That is not a
 * hypothetical: the first version of this probe reported three surfaces
 * "genuinely broken" while never having reached Microsoft at all.
 */
export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCap(...a),
}));

const mockToken = jest.fn();
jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: (...a: unknown[]) => mockToken(...a),
}));

const mockAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockAudit(...a),
  extractRequestMetadata: () => ({}),
}));

const mockProbeAll = jest.fn();
jest.mock("@/lib/integrations/probe", () => ({
  probeAll: (...a: unknown[]) => mockProbeAll(...a),
}));

const CTO = { id: "u_cto", email: "cto@wolfpack.test", role: "cto", workspaceId: "ws-1" };

function req(): any {
  return { url: "http://x/api/admin/integrations/probe", headers: new Headers() };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockRequireCap.mockResolvedValue({ ok: true, user: CTO, capabilities: new Set() });
  mockToken.mockResolvedValue({ accessToken: "tok", userEmail: "a@b.c" });
  mockProbeAll.mockResolvedValue([{ label: "People", verdict: "works", detail: "3 item(s)" }]);
});

describe("authorisation", () => {
  it("403s without settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({
      ok: false,
      response: new Response(JSON.stringify({ error: "forbidden" }), { status: 403 }),
    });
    const { POST } = await import("@/app/api/admin/integrations/probe/route");
    const res = await POST(req());
    expect(res.status).toBe(403);
    expect(mockProbeAll).not.toHaveBeenCalled();
  });
});

describe("refusing to report what it did not observe", () => {
  /* THE ASSERTION THIS ROUTE EXISTS FOR. Without a live token every surface
     fails identically for a reason that says nothing about the integration. */
  it("probes nothing when the token is dead, and says so", async () => {
    mockToken.mockResolvedValue(null);
    const { POST } = await import("@/app/api/admin/integrations/probe/route");
    const res = await POST(req());
    expect(res.status).toBe(409);
    const body = (await res.json()) as { probed: boolean; reason: string };
    expect(body.probed).toBe(false);
    expect(body.reason).toBe("no_live_token");
    expect(mockProbeAll).not.toHaveBeenCalled();
  });

  it("probes nothing when the caller has no account to probe with", async () => {
    mockRequireCap.mockResolvedValue({
      ok: true,
      user: { ...CTO, email: "" },
      capabilities: new Set(),
    });
    const { POST } = await import("@/app/api/admin/integrations/probe/route");
    const res = await POST(req());
    expect(res.status).toBe(409);
    expect((await res.json()).reason).toBe("no_connected_account");
    expect(mockProbeAll).not.toHaveBeenCalled();
  });
});

describe("when it can genuinely probe", () => {
  it("returns a verdict per surface", async () => {
    const { POST } = await import("@/app/api/admin/integrations/probe/route");
    const res = await POST(req());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { probed: boolean; results: unknown[] };
    expect(body.probed).toBe(true);
    expect(body.results).toHaveLength(1);
  });

  /* An administrator spending live third-party calls on a tenant credential.
     Read-only does not mean unremarkable: who ran it, when, and against whose
     account is the question asked afterwards. */
  it("records who ran it, and the verdicts rather than the data", async () => {
    const { POST } = await import("@/app/api/admin/integrations/probe/route");
    await POST(req());
    expect(mockAudit).toHaveBeenCalledTimes(1);
    const entry = mockAudit.mock.calls[0][0];
    expect(entry).toMatchObject({ action: "integrations.probed", resourceId: "ws-1" });
    expect(entry.afterState.verdicts).toEqual(["People:works"]);
  });

  /* A failing audit must not cost the caller their answer. */
  it("still returns results when the audit write fails", async () => {
    mockAudit.mockRejectedValue(new Error("chain down"));
    const { POST } = await import("@/app/api/admin/integrations/probe/route");
    const res = await POST(req());
    expect(res.status).toBe(200);
  });

  /* PROBES AS THE CALLER. The first version picked whichever token row was
     most recently updated, which let an administrator spend a colleague's
     credential without either of them choosing it, and filtered on a
     workspace_id column that does not exist on that table. */
  it("probes with the caller's own connected account", async () => {
    const { POST } = await import("@/app/api/admin/integrations/probe/route");
    await POST(req());
    expect(mockToken).toHaveBeenCalledWith("cto@wolfpack.test");
    expect(mockProbeAll).toHaveBeenCalledWith("cto@wolfpack.test");
  });
});

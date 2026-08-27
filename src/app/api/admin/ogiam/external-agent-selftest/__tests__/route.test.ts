/**
 * Contract for the external-agent selftest.
 *
 * It mints a real credential and revokes it, so the assertions that matter are
 * about who may call it, that it points at its own deployment rather than at
 * whatever a config variable names, and that a failing gate is reported as a
 * failing gate rather than as a broken request.
 */
const mockRequire = jest.fn();
const mockExercise = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequire(...a),
}));
jest.mock("@/lib/ogiam/external-agent-exercise", () => ({
  runExternalAgentExercise: (...a: unknown[]) => mockExercise(...a),
}));
const mockAudit = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/audit-log", () => ({ recordAudit: (...a: unknown[]) => mockAudit(...a) }));

import { POST } from "@/app/api/admin/ogiam/external-agent-selftest/route";

function req(url = "https://wolfpack-instinct.vercel.app/api/admin/ogiam/external-agent-selftest") {
  return { url, headers: new Headers() } as never;
}

const passingReport = {
  steps: [{ name: "s", expectation: "e", passed: true, observed: "o" }],
  passed: true,
  keysCleanedUp: 1,
  inconclusive: false,
};

beforeEach(() => {
  jest.clearAllMocks();
  mockRequire.mockResolvedValue({
    ok: true,
    user: { id: "u1", role: "cto", workspaceId: "ws1" },
    capabilities: new Set(["settings.manage_team"]),
  });
  mockExercise.mockResolvedValue(passingReport);
});

describe("authorization", () => {
  /* Minting credentials is the same privilege as minting them by hand. */
  it("requires the capability that mints keys", async () => {
    await POST(req());
    expect(mockRequire).toHaveBeenCalledWith(expect.anything(), "settings.manage_team");
  });

  it("returns the guard's refusal and mints nothing", async () => {
    mockRequire.mockResolvedValue({ ok: false, response: new Response(null, { status: 403 }) });
    expect((await POST(req())).status).toBe(403);
    expect(mockExercise).not.toHaveBeenCalled();
  });
});

describe("what it exercises", () => {
  it("passes a gate caller and the caller's identity to the harness", async () => {
    await POST(req());
    const deps = mockExercise.mock.calls[0][0] as { callGate: unknown };
    expect(typeof deps.callGate).toBe("function");
    expect(mockExercise).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: "ws1", createdBy: "u1" }),
    );
  });

  /* SERVER-SIDE REQUEST FORGERY. This read the origin from req.url, which is
     derived from the Host header and therefore chosen by the caller: a request
     carrying an internal hostname would have made the server fetch that host
     with a bearer token attached. In a route whose job is to demonstrate that
     this product gates what agents may reach. */
  it("never takes the target host from the request", async () => {
    const fetchSpy = jest.spyOn(global, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ allowed: true }), { status: 200 }),
    );
    mockExercise.mockImplementation(async (deps: { callGate: (k: string, b: unknown) => Promise<unknown> }) => {
      await deps.callGate("ogk_test", { tool: "t", capability: "c", isMutation: false });
      return passingReport;
    });

    await POST(req("https://attacker.internal/api/admin/ogiam/external-agent-selftest"));

    const called = String(fetchSpy.mock.calls[0]?.[0] ?? "");
    expect(called).not.toContain("attacker.internal");
    fetchSpy.mockRestore();
  });

  /* A loopback default in a deployed function means the function calls
     ITSELF, which looks like a pass while proving nothing about the gate. */
  it("refuses to run rather than call itself when no origin is configured", async () => {
    const saved = {
      vercel: process.env.VERCEL_URL,
      own: process.env.SELFTEST_ORIGIN,
      deployed: process.env.VERCEL,
    };
    delete process.env.VERCEL_URL;
    delete process.env.SELFTEST_ORIGIN;
    process.env.VERCEL = "1";

    const res = await POST(req());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "selftest_could_not_run" });

    process.env.VERCEL_URL = saved.vercel;
    process.env.SELFTEST_ORIGIN = saved.own;
    if (saved.deployed === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = saved.deployed;
  });

  it("scopes the run to the caller's own workspace", async () => {
    await POST(req());
    expect(mockExercise).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "ws1" }));
  });
});

describe("reporting", () => {
  it("returns the report when every step passed", async () => {
    const res = await POST(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ report: { passed: true } });
  });

  /* A failing gate is not a failing request. 200 with passed:false, so a
     reader can tell "the gate is broken" from "the check could not run". */
  it("reports a failing gate as a served report, not an error", async () => {
    mockExercise.mockResolvedValue({ ...passingReport, passed: false });
    const res = await POST(req());
    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toMatchObject({ report: { passed: false } });
  });

  it("reports an unrunnable check as 503, which is a different fact", async () => {
    mockExercise.mockRejectedValue(new Error("gate unreachable"));
    const res = await POST(req());
    expect(res.status).toBe(503);
    await expect(res.json()).resolves.toMatchObject({ error: "selftest_could_not_run" });
  });
});

describe("it is audited", () => {
  /* The key is revoked before the response returns, but "a credential existed
     briefly" is still a credential event, and the question asked later is who
     created keys and when. */
  it("records that a credential was minted and revoked", async () => {
    await POST(req());
    expect(mockAudit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "ogiam.external_agent_selftest_run",
        resourceType: "gate_api_key",
      }),
    );
  });

  it("does not lose the report when the audit write fails", async () => {
    mockAudit.mockRejectedValueOnce(new Error("audit down"));
    expect((await POST(req())).status).toBe(200);
  });
});

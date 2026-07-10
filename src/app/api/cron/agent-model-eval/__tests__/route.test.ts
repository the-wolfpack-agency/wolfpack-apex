/**
 * Contract tests for GET /api/cron/agent-model-eval: the model-regression sweep.
 *
 *   - no / wrong CRON_SECRET and no capability -> 401.
 *   - valid CRON_SECRET -> 200 { ok: true, result } from runModelEvalSweep.
 *   - user path (capability) -> 200 { ok: true, result }.
 *   - recoverable throw inside the sweep -> 200 zeroed (never 500).
 *
 * Mirrors src/app/api/cron/agent-drift exactly.
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockRunModelEvalSweep = jest.fn();
jest.mock("@/lib/agents/evals/store", () => ({
  runModelEvalSweep: (...a: any[]) => mockRunModelEvalSweep(...a),
}));

jest.mock("@/lib/db", () => ({
  query: jest.fn(),
  safeQuery: jest.fn(),
  writeQuery: jest.fn(),
}));

import { NextRequest } from "next/server";

const CTO = { id: "u_cto", email: "cto@x.com", role: "cto", workspaceId: "default" };

const ORIGINAL_ENV = { ...process.env };

function reqWith(auth?: string): NextRequest {
  return new NextRequest("https://wp.test/api/cron/agent-model-eval", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "secret-x";
  mockRunModelEvalSweep.mockResolvedValue({ checked: 4, regressed: 1 });
  mockRequireCap.mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("GET /api/cron/agent-model-eval", () => {
  it("401 with no secret and no capability", async () => {
    const { GET } = await import("@/app/api/cron/agent-model-eval/route");
    const res = await GET(reqWith());
    expect(res.status).toBe(401);
    expect(mockRunModelEvalSweep).not.toHaveBeenCalled();
  });

  it("401 with a wrong secret and no capability", async () => {
    const { GET } = await import("@/app/api/cron/agent-model-eval/route");
    const res = await GET(reqWith("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockRunModelEvalSweep).not.toHaveBeenCalled();
  });

  it("401 when CRON_SECRET is unset and there is no capability", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("@/app/api/cron/agent-model-eval/route");
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(401);
    expect(mockRunModelEvalSweep).not.toHaveBeenCalled();
  });

  it("200 with the sweep result on a valid CRON_SECRET", async () => {
    const { GET } = await import("@/app/api/cron/agent-model-eval/route");
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { checked: number; regressed: number } };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ checked: 4, regressed: 1 });
    expect(mockRunModelEvalSweep).toHaveBeenCalledTimes(1);
    expect(mockRequireCap).not.toHaveBeenCalled();
  });

  it("200 via the user path when an admin has settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/cron/agent-model-eval/route");
    const res = await GET(reqWith());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: unknown };
    expect(body.ok).toBe(true);
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
    expect(mockRunModelEvalSweep).toHaveBeenCalledTimes(1);
  });

  it("returns a zeroed 200 (never 500) on a recoverable throw", async () => {
    mockRunModelEvalSweep.mockRejectedValue(new Error("db unreachable"));
    const { GET } = await import("@/app/api/cron/agent-model-eval/route");
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: { checked: number; regressed: number } };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ checked: 0, regressed: 0 });
  });
});

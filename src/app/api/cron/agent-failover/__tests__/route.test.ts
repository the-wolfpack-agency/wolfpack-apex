/**
 * Contract tests for GET /api/cron/agent-failover: the failover sweep.
 *
 *   - no / wrong CRON_SECRET and no capability -> 401.
 *   - valid CRON_SECRET -> 200 { ok, result } from runFailoverSweep (cron path
 *     never consults the capability guard).
 *   - user path (capability) -> 200 { ok, result }, gated on settings.manage_team.
 *   - recoverable throw inside the sweep -> 200 zeroed (never 500).
 */

export {};

const mockRequireCap = jest.fn();
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: any[]) => mockRequireCap(...a),
}));

const mockRunFailoverSweep = jest.fn();
jest.mock("@/lib/agents/failover/store", () => ({
  runFailoverSweep: (...a: any[]) => mockRunFailoverSweep(...a),
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
  return new NextRequest("https://wp.test/api/cron/agent-failover", {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.CRON_SECRET = "secret-x";
  mockRunFailoverSweep.mockResolvedValue({ reclaimed: 2, reassigned: 3, skipped: 1 });
  mockRequireCap.mockResolvedValue({
    ok: false,
    response: new Response(JSON.stringify({ error: "unauthorized" }), { status: 401 }),
  });
});

afterAll(() => {
  process.env = ORIGINAL_ENV;
});

describe("GET /api/cron/agent-failover", () => {
  it("401 with no secret and no capability", async () => {
    const { GET } = await import("@/app/api/cron/agent-failover/route");
    const res = await GET(reqWith());
    expect(res.status).toBe(401);
    expect(mockRunFailoverSweep).not.toHaveBeenCalled();
  });

  it("401 with a wrong secret and no capability", async () => {
    const { GET } = await import("@/app/api/cron/agent-failover/route");
    const res = await GET(reqWith("Bearer wrong"));
    expect(res.status).toBe(401);
    expect(mockRunFailoverSweep).not.toHaveBeenCalled();
  });

  it("401 when CRON_SECRET is unset and there is no capability", async () => {
    delete process.env.CRON_SECRET;
    const { GET } = await import("@/app/api/cron/agent-failover/route");
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(401);
    expect(mockRunFailoverSweep).not.toHaveBeenCalled();
  });

  it("200 with the sweep result on a valid CRON_SECRET (no capability consulted)", async () => {
    const { GET } = await import("@/app/api/cron/agent-failover/route");
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: unknown };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ reclaimed: 2, reassigned: 3, skipped: 1 });
    expect(mockRunFailoverSweep).toHaveBeenCalledTimes(1);
    expect(mockRequireCap).not.toHaveBeenCalled();
  });

  it("200 via the user path when an admin has settings.manage_team", async () => {
    mockRequireCap.mockResolvedValue({ ok: true, user: CTO });
    const { GET } = await import("@/app/api/cron/agent-failover/route");
    const res = await GET(reqWith());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean };
    expect(body.ok).toBe(true);
    expect(mockRequireCap.mock.calls[0][1]).toBe("settings.manage_team");
    expect(mockRunFailoverSweep).toHaveBeenCalledTimes(1);
  });

  it("returns a zeroed 200 (never 500) on a recoverable throw", async () => {
    mockRunFailoverSweep.mockRejectedValue(new Error("db unreachable"));
    const { GET } = await import("@/app/api/cron/agent-failover/route");
    const res = await GET(reqWith("Bearer secret-x"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; result: unknown };
    expect(body.ok).toBe(true);
    expect(body.result).toEqual({ reclaimed: 0, reassigned: 0, skipped: 0 });
  });
});

/**
 * Contract tests for GET /api/admin/ogiam/selftest.
 *
 * Covers: 401 when the capability check denies; 200 with the
 * { workspace_id, report } shape (scoped to the caller's workspace) on a healthy
 * gate; 200 even when the report's allPassed is false (the body, not the status,
 * conveys gate health); default-workspace fallback; graceful degrade when the
 * harness throws.
 */

const mockRunGateSelfTest = jest.fn();
const mockRequireCapability = jest.fn();

jest.mock("@/lib/ogiam/gate-selftest", () => ({
  runGateSelfTest: (...a: unknown[]) => mockRunGateSelfTest(...a),
}));
jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";

beforeEach(() => {
  mockRunGateSelfTest.mockReset();
  mockRequireCapability.mockReset();
});

function req(): NextRequest {
  return new NextRequest("https://wp.test/api/admin/ogiam/selftest", { method: "GET" });
}

const healthyReport = {
  correct: 6,
  total: 6,
  allPassed: true,
  latency: { p50: 1, p95: 2, max: 3 },
  chainVerified: true,
  cases: [],
};

describe("GET /api/admin/ogiam/selftest", () => {
  test("401 when the capability check denies", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "unauthorized" }, { status: 401 }),
    });

    const res = await GET(req());

    expect(res.status).toBe(401);
    expect(mockRunGateSelfTest).not.toHaveBeenCalled();
  });

  test("403 when the capability check forbids", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: false,
      response: NextResponse.json({ error: "forbidden" }, { status: 403 }),
    });

    const res = await GET(req());

    expect(res.status).toBe(403);
    expect(mockRunGateSelfTest).not.toHaveBeenCalled();
  });

  test("200 with the report, scoped to the caller's workspace", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { id: "u-1", role: "cto", workspaceId: "ws-42" },
      capabilities: new Set(["settings.manage_team"]),
    });
    mockRunGateSelfTest.mockResolvedValueOnce(healthyReport);

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_id).toBe("ws-42");
    expect(body.report).toEqual(healthyReport);
    expect(mockRunGateSelfTest).toHaveBeenCalledWith("ws-42");
  });

  test("200 even when a case fails (allPassed false conveys health, not the status)", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { id: "u-1", role: "cto", workspaceId: "ws-42" },
      capabilities: new Set(["settings.manage_team"]),
    });
    mockRunGateSelfTest.mockResolvedValueOnce({
      ...healthyReport,
      correct: 5,
      allPassed: false,
    });

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.report.allPassed).toBe(false);
    expect(body.report.correct).toBe(5);
  });

  test("falls back to the default workspace when the user has none", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { id: "u-1", role: "cto", workspaceId: null },
      capabilities: new Set(["settings.manage_team"]),
    });
    mockRunGateSelfTest.mockResolvedValueOnce(healthyReport);

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.workspace_id).toBe("default");
    expect(mockRunGateSelfTest).toHaveBeenCalledWith("default");
  });

  test("graceful degrade: 200 with an unhealthy report when the harness throws", async () => {
    mockRequireCapability.mockResolvedValueOnce({
      ok: true,
      user: { id: "u-1", role: "cto", workspaceId: "ws-42" },
      capabilities: new Set(["settings.manage_team"]),
    });
    mockRunGateSelfTest.mockRejectedValueOnce(new Error("boom"));

    const res = await GET(req());
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.report.allPassed).toBe(false);
    expect(body.report.chainVerified).toBe(false);
    expect(body.message).toBeDefined();
  });
});

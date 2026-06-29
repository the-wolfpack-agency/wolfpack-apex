/**
 * Contract tests for the AI Surface Inventory routes:
 *   GET  /api/admin/ai-surfaces        (list + summary)
 *   POST /api/admin/ai-surfaces/scan   (run discovery)
 * Locks auth (401/403), GET shape + filters + analytics, POST validation (400),
 * and the scan happy-path (discovery + ai_inventory.scan_completed). The lib is
 * mocked so these stay contract tests.
 */

export {};

const mockRequireCapability = jest.fn();
const mockList = jest.fn();
const mockRunDiscovery = jest.fn();
const mockTrackEvent = jest.fn();

jest.mock("@/lib/auth/require-capability", () => ({
  requireCapability: (...a: unknown[]) => mockRequireCapability(...a),
}));
jest.mock("@/lib/ai-surface/store", () => {
  const actual = jest.requireActual("@/lib/ai-surface/store");
  return { ...actual, listSurfaces: (...a: unknown[]) => mockList(...a) };
});
jest.mock("@/lib/ai-surface/inventory", () => ({
  runDiscovery: (...a: unknown[]) => mockRunDiscovery(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));

import { NextRequest, NextResponse } from "next/server";
import { GET } from "../route";
import { POST } from "../scan/route";

const okAuth = () => ({ ok: true, user: { id: "u-1", role: "cto", workspaceId: "w-1" }, capabilities: new Set() });
const deny = (s: number) => ({ ok: false, response: NextResponse.json({ error: "no" }, { status: s }) });

function getReq(qs = ""): NextRequest {
  return new NextRequest(`https://x.test/api/admin/ai-surfaces${qs}`, { method: "GET", headers: { authorization: "Bearer t" } });
}
function postReq(body?: unknown): NextRequest {
  return new NextRequest("https://x.test/api/admin/ai-surfaces/scan", {
    method: "POST",
    headers: { authorization: "Bearer t", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeEach(() => {
  jest.resetAllMocks();
  mockList.mockResolvedValue([]);
});

describe("GET /api/admin/ai-surfaces", () => {
  it("401 when unauthenticated", async () => {
    mockRequireCapability.mockResolvedValue(deny(401));
    expect((await GET(getReq())).status).toBe(401);
  });

  it("returns surfaces + a summary, scoped to the workspace, and tracks the view", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockList.mockResolvedValue([
      { id: "1", target: "r", kind: "ai_sdk", provider: "openai", location: "a:1", governed: false, risk: "medium", evidence: {}, firstSeenAt: "", lastSeenAt: "" },
      { id: "2", target: "r", kind: "api_key", provider: "anthropic", location: "b:2", governed: false, risk: "critical", evidence: {}, firstSeenAt: "", lastSeenAt: "" },
    ]);
    const res = await GET(getReq("?ungoverned=true"));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.summary).toMatchObject({ total: 2, ungoverned: 2 });
    expect(mockList).toHaveBeenCalledWith("w-1", { target: undefined, ungovernedOnly: true });
    expect(mockTrackEvent).toHaveBeenCalledWith("ai_inventory.viewed", "u-1", "cto", { total: 2, ungoverned: 2 });
  });
});

describe("POST /api/admin/ai-surfaces/scan", () => {
  it("403 when lacking capability", async () => {
    mockRequireCapability.mockResolvedValue(deny(403));
    expect((await POST(postReq({ target: "r", files: [{ path: "a", content: "b" }] }))).status).toBe(403);
  });

  it("400 on missing target or empty files", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    expect((await POST(postReq({ files: [{ path: "a", content: "b" }] }))).status).toBe(400);
    expect((await POST(postReq({ target: "r", files: [] }))).status).toBe(400);
    expect(mockRunDiscovery).not.toHaveBeenCalled();
  });

  it("runs discovery, persists, and emits ai_inventory.scan_completed", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockRunDiscovery.mockResolvedValue({
      target: "repo",
      surfaces: [{ kind: "ai_sdk", provider: "openai", location: "a:1", governed: false, risk: "medium", evidence: {} }],
      written: 1,
      summary: { total: 1, ungoverned: 1, byKind: {}, byProvider: {}, byRisk: {} },
    });
    const res = await POST(postReq({ target: "repo", files: [{ path: "a.ts", content: 'import "openai"' }] }));
    expect(res.status).toBe(200);
    expect(mockRunDiscovery).toHaveBeenCalledWith({ workspaceId: "w-1", target: "repo", files: [{ path: "a.ts", content: 'import "openai"' }] });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "ai_inventory.scan_completed",
      "u-1",
      "cto",
      expect.objectContaining({ target: "repo", surfaces: 1, ungoverned: 1, written: 1 }),
    );
  });

  it("filters out malformed file entries", async () => {
    mockRequireCapability.mockResolvedValue(okAuth());
    mockRunDiscovery.mockResolvedValue({ target: "r", surfaces: [], written: 0, summary: { total: 0, ungoverned: 0, byKind: {}, byProvider: {}, byRisk: {} } });
    await POST(postReq({ target: "r", files: [{ path: "a", content: "x" }, { path: 42 }, { nope: true }] }));
    expect(mockRunDiscovery).toHaveBeenCalledWith({ workspaceId: "w-1", target: "r", files: [{ path: "a", content: "x" }] });
  });
});

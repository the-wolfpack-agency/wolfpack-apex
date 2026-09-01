/**
 * Contract for GET /api/admin/agents/behavior.
 *
 * 200 / 401 asserted explicitly. A 401 that nobody asserts renders as a blank
 * panel, which is a bug class this codebase has already lived through.
 */
const mockGetFleetBehavior = jest.fn();
let mockAuth: () => Promise<unknown> = async () => ({
  ok: true,
  user: { id: "admin-1", role: "admin", workspaceId: "ws-1" },
});

jest.mock("@/lib/auth/require-capability", () => ({ requireCapability: () => mockAuth() }));
jest.mock("@/lib/agents/evals/behavior-summary", () => ({
  getFleetBehavior: (...a: unknown[]) => mockGetFleetBehavior(...a),
}));

import { NextRequest } from "next/server";
import { GET } from "../route";

function get(qs = ""): NextRequest {
  return new NextRequest(`http://localhost/api/admin/agents/behavior${qs}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockAuth = async () => ({ ok: true, user: { id: "admin-1", role: "admin", workspaceId: "ws-1" } });
  mockGetFleetBehavior.mockResolvedValue([]);
});

describe("GET", () => {
  it("returns 200 with the fleet's behavior", async () => {
    mockGetFleetBehavior.mockResolvedValue([{ agentId: "a1", standing: "good" }]);
    const res = await GET(get());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.agents).toHaveLength(1);
    expect(body.days).toBe(30);
  });

  it("returns 401 when unauthenticated, rather than an empty list", async () => {
    // An empty list would render as "no agents have misbehaved", which is a
    // very different claim from "you are not signed in".
    mockAuth = async () => ({ ok: false, response: new Response(null, { status: 401 }) });
    expect((await GET(get())).status).toBe(401);
    expect(mockGetFleetBehavior).not.toHaveBeenCalled();
  });

  it("honours a window", async () => {
    await GET(get("?days=7"));
    expect(mockGetFleetBehavior).toHaveBeenCalledWith(7);
  });

  it("clamps an unbounded window instead of scanning the whole event table", async () => {
    await GET(get("?days=99999"));
    expect(mockGetFleetBehavior).toHaveBeenCalledWith(180);
  });

  it.each(["?days=0", "?days=-5", "?days=abc", "?days="])("falls back to the default for %s", async (qs) => {
    await GET(get(qs));
    expect(mockGetFleetBehavior).toHaveBeenCalledWith(30);
  });

  it("floors a fractional window rather than passing it to SQL", async () => {
    await GET(get("?days=7.9"));
    expect(mockGetFleetBehavior).toHaveBeenCalledWith(7);
  });
});

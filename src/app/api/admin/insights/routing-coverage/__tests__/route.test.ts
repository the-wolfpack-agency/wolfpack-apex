/**
 * GET /api/admin/insights/routing-coverage: the gate, and the honest failure.
 *
 * Asserts 401/403/200 rather than "not 500", because a 401 on a page that
 * renders without checking is how this product shipped a blank dashboard.
 */

const mockGetUser = jest.fn();
const mockAudit = jest.fn();

jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUser(...a),
}));
jest.mock("@/lib/assistant/routing-audit", () => ({
  auditRouting: (...a: unknown[]) => mockAudit(...a),
}));

import { GET } from "../route";

function req() {
  return {
    headers: { get: () => "Bearer t" },
    nextUrl: { searchParams: new URLSearchParams() },
  } as never;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetUser.mockReturnValue({ role: "cto" });
  mockAudit.mockResolvedValue({
    total: 36,
    reachedOne: 30,
    reachedNone: 4,
    reachedMany: 2,
    none: ["who emailed me today"],
    many: [],
    byGroup: { mail: { total: 4, none: 1 }, status: { total: 3, none: 0 } },
  });
});

describe("the gate", () => {
  it("401s an unauthenticated caller", async () => {
    mockGetUser.mockReturnValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("403s a role that may not read it", async () => {
    mockGetUser.mockReturnValue({ role: "sales" });
    expect((await GET(req())).status).toBe(403);
  });

  it.each(["cto", "ceo", "evp"])("200s for %s", async (role) => {
    mockGetUser.mockReturnValue({ role });
    expect((await GET(req())).status).toBe(200);
  });
});

describe("the payload", () => {
  it("returns the score and the prompts that reach nothing", async () => {
    const body = await (await GET(req())).json();
    expect(body).toMatchObject({ readable: true, percent: 83, reachedOne: 30, total: 36 });
    expect(body.unreachable).toContain("who emailed me today");
  });

  it("names a cluster where every prompt fails, because that is a missing capability", async () => {
    mockAudit.mockResolvedValue({
      total: 3, reachedOne: 0, reachedNone: 3, reachedMany: 0,
      none: ["a", "b", "c"], many: [],
      byGroup: { status: { total: 3, none: 3 }, mail: { total: 0, none: 0 } },
    });
    const body = await (await GET(req())).json();
    expect(body.deadClusters).toContain("status");
  });

  it("reports unreadable rather than a score of zero when the audit throws", async () => {
    /* A page showing 0% because the registry failed to load would be reporting
       a catastrophe that had not happened. */
    mockAudit.mockRejectedValue(new Error("registry broken"));
    const res = await GET(req());
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.readable).toBe(false);
    expect(body.percent).toBeUndefined();
  });

  it("returns a null percent for an empty corpus, not zero percent", async () => {
    mockAudit.mockResolvedValue({
      total: 0, reachedOne: 0, reachedNone: 0, reachedMany: 0, none: [], many: [], byGroup: {},
    });
    expect((await (await GET(req())).json()).percent).toBeNull();
  });

  it("is never cached, because the whole point is that it is current", async () => {
    expect((await GET(req())).headers.get("Cache-Control")).toMatch(/no-store/);
  });
});

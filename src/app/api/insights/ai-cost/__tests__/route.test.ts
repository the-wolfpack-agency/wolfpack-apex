/**
 * Contract + logic tests for GET /api/insights/ai-cost.
 *
 *   - 401 without auth.
 *   - non-org role → workspace-scoped query (bound workspace param).
 *   - org role (cto) → org scope, by_workspace populated, no workspace param.
 *   - DB-down (fromCache) → 200 + zeroed shadow report (never an error page).
 *   - days clamped to [1,365].
 *   - pure summarize/bucketBy rollups.
 */
const mockGetUserFromRequest = jest.fn();
jest.mock("@/lib/auth", () => ({
  getUserFromRequest: (...a: unknown[]) => mockGetUserFromRequest(...a),
}));
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
}));

import { NextRequest } from "next/server";
import { GET, summarize, bucketBy } from "@/app/api/insights/ai-cost/route";

function makeReq(auth?: string, days?: string): NextRequest {
  const u = new URL("http://test/api/insights/ai-cost");
  if (days !== undefined) u.searchParams.set("days", days);
  return new NextRequest(u, {
    method: "GET",
    headers: auth ? { authorization: auth } : {},
  });
}

const ROW = (over: Partial<Record<string, unknown>> = {}) => ({
  day: "2026-06-01",
  workspace_id: "default",
  feature: "support.draft",
  provider: "azure-openai",
  model: "gpt-4o-mini",
  user_id: "u1",
  calls: 2,
  cost_usd: 0.02,
  input_tokens: 100,
  output_tokens: 50,
  fallbacks: 0,
  semantic_hits: 1,
  ...over,
});

beforeEach(() => jest.clearAllMocks());

describe("auth + scope", () => {
  test("401 without auth", async () => {
    mockGetUserFromRequest.mockReturnValueOnce(null);
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
  });

  test("non-org role scopes to its own workspace via bound param", async () => {
    mockGetUserFromRequest.mockReturnValueOnce({ role: "sales", workspaceId: "ws-sales" });
    mockSafeQuery.mockResolvedValueOnce({ rows: [ROW({ workspace_id: "ws-sales" })], fromCache: false });
    const res = await GET(makeReq("Bearer x"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.scope).toBe("workspace");
    expect(body.workspace_id).toBe("ws-sales");
    // query carried the workspace param + the scoping predicate.
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).toMatch(/AND workspace_id = \$1/);
    expect(params).toEqual(["ws-sales"]);
    expect(body.by_workspace).toEqual([]); // not exposed to non-org
  });

  test("org role (cto) gets org scope + by_workspace, no workspace param", async () => {
    mockGetUserFromRequest.mockReturnValueOnce({ role: "cto", workspaceId: "ws-exec" });
    mockSafeQuery.mockResolvedValueOnce({
      rows: [ROW({ workspace_id: "a" }), ROW({ workspace_id: "b", cost_usd: 0.05 })],
      fromCache: false,
    });
    const res = await GET(makeReq("Bearer x"));
    const body = await res.json();
    expect(body.scope).toBe("org");
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(sql).not.toMatch(/AND workspace_id/);
    expect(params).toEqual([]);
    expect(body.by_workspace.map((b: { key: string }) => b.key).sort()).toEqual(["a", "b"]);
    // sorted by spend desc, b (0.05) before a (0.02).
    expect(body.by_workspace[0].key).toBe("b");
  });

  test("DB-down → zeroed shadow report, still 200", async () => {
    mockGetUserFromRequest.mockReturnValueOnce({ role: "ops", workspaceId: "w" });
    mockSafeQuery.mockResolvedValueOnce({ rows: [], fromCache: true });
    const res = await GET(makeReq("Bearer x"));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.shadow_mode).toBe(true);
    expect(body.total.cost_usd).toBe(0);
  });

  test("days clamps to [1,365]", async () => {
    mockGetUserFromRequest.mockReturnValue({ role: "ops", workspaceId: "w" });
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
    await GET(makeReq("Bearer x", "9999"));
    expect(mockSafeQuery.mock.calls[0][0]).toMatch(/INTERVAL '365 days'/);
    await GET(makeReq("Bearer x", "-4"));
    expect(mockSafeQuery.mock.calls[1][0]).toMatch(/INTERVAL '1 days'/);
  });
});

describe("pure rollups", () => {
  test("summarize totals cost/tokens/savings and groups by feature+provider", () => {
    const rows = [
      ROW({ feature: "a", provider: "azure-openai", cost_usd: 0.10, calls: 1, semantic_hits: 1 }),
      ROW({ feature: "b", provider: "anthropic", cost_usd: 0.30, calls: 2, fallbacks: 1, semantic_hits: 0 }),
      ROW({ feature: "a", provider: "azure-openai", cost_usd: 0.05, calls: 1, semantic_hits: 0 }),
    ] as never[];
    const r = summarize(rows, 30, "org", "x");
    expect(r.total.cost_usd).toBe(0.45);
    expect(r.total.calls).toBe(4);
    expect(r.total.semantic_hits).toBe(1);
    expect(r.total.fallbacks).toBe(1);
    // by_feature sorted by spend desc: a=0.15 > b? no, b=0.30 > a=0.15.
    expect(r.by_feature[0].key).toBe("b");
    expect(r.by_feature.find((x) => x.key === "a")!.cost_usd).toBe(0.15);
  });

  test("bucketBy rounds to 4dp and sorts by spend then calls", () => {
    const out = bucketBy(
      [ROW({ provider: "p", cost_usd: 0.1 }), ROW({ provider: "p", cost_usd: 0.2 })] as never[],
      "provider",
    );
    expect(out).toEqual([{ key: "p", calls: 4, cost_usd: 0.3 }]);
  });
});

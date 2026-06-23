/**
 * Unit tests for the OGIAM decision explorer read queries.
 *
 * We mock @/lib/db safeQuery and assert: every query is workspace-scoped on the
 * parameterized workspace_id, the limit is clamped, the wouldBlockOnly filter is
 * forwarded into SQL, and summarizeDecisions maps the grouped counts correctly.
 */

export {};

const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: any[]) => mockSafeQuery(...a),
}));

import {
  listDecisions,
  summarizeDecisions,
  clampDecisionsLimit,
  OGIAM_DECISIONS_DEFAULT_LIMIT,
  OGIAM_DECISIONS_MAX_LIMIT,
} from "@/lib/ogiam/queries";

beforeEach(() => {
  jest.clearAllMocks();
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
});

describe("clampDecisionsLimit", () => {
  it("defaults when undefined / non-finite", () => {
    expect(clampDecisionsLimit(undefined)).toBe(OGIAM_DECISIONS_DEFAULT_LIMIT);
    expect(clampDecisionsLimit(NaN)).toBe(OGIAM_DECISIONS_DEFAULT_LIMIT);
  });
  it("clamps to [1, max]", () => {
    expect(clampDecisionsLimit(0)).toBe(1);
    expect(clampDecisionsLimit(-50)).toBe(1);
    expect(clampDecisionsLimit(99999)).toBe(OGIAM_DECISIONS_MAX_LIMIT);
    expect(clampDecisionsLimit(42)).toBe(42);
  });
});

describe("listDecisions", () => {
  it("is workspace-scoped on the parameterized workspace_id, newest first", async () => {
    await listDecisions("ws_1");
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = mockSafeQuery.mock.calls[0];
    expect(String(sql)).toContain("FROM ogiam_decisions");
    expect(String(sql)).toContain("WHERE workspace_id = $1");
    expect(String(sql)).toContain("ORDER BY created_at DESC");
    expect(params).toEqual(["ws_1"]);
  });

  it("clamps the limit into the SQL (default 100, max 500)", async () => {
    await listDecisions("ws_1");
    expect(String(mockSafeQuery.mock.calls[0][0])).toContain("LIMIT 100");

    mockSafeQuery.mockClear();
    await listDecisions("ws_1", { limit: 99999 });
    expect(String(mockSafeQuery.mock.calls[0][0])).toContain("LIMIT 500");

    mockSafeQuery.mockClear();
    await listDecisions("ws_1", { limit: 5 });
    expect(String(mockSafeQuery.mock.calls[0][0])).toContain("LIMIT 5");
  });

  it("adds the would_block filter only when wouldBlockOnly is set", async () => {
    await listDecisions("ws_1", { wouldBlockOnly: true });
    expect(String(mockSafeQuery.mock.calls[0][0])).toContain("would_block = true");

    mockSafeQuery.mockClear();
    await listDecisions("ws_1", { wouldBlockOnly: false });
    expect(String(mockSafeQuery.mock.calls[0][0])).not.toContain("would_block = true");
  });

  it("maps the rows straight through", async () => {
    mockSafeQuery.mockResolvedValueOnce({
      rows: [
        {
          id: "d1",
          created_at: "2026-06-01T00:00:00.000Z",
          principal_agent: "assistant",
          on_behalf_user_id: "u1",
          on_behalf_role: "cto",
          tool: "mail.send",
          capability: "mail.send",
          is_mutation: true,
          surface: "/assistant",
          risk_tier: "high",
          intended_outcome: "escalate",
          effective_outcome: "allow",
          enforced: false,
          would_block: true,
          rule_id: "R-001",
          reason: "high-risk mutation",
          policy_version: "v0",
        },
      ],
      fromCache: false,
    });
    const rows = await listDecisions("ws_1");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("d1");
    expect(rows[0].would_block).toBe(true);
    expect(rows[0].risk_tier).toBe("high");
  });
});

describe("summarizeDecisions", () => {
  it("scopes every aggregate query to the workspace and maps grouped counts", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ total: 7, would_block: 2 }], fromCache: false })
      .mockResolvedValueOnce({
        rows: [
          { key: "low", n: 4 },
          { key: "high", n: 2 },
          { key: "critical", n: 1 },
        ],
        fromCache: false,
      })
      .mockResolvedValueOnce({
        rows: [
          { key: "allow", n: 5 },
          { key: "deny", n: 1 },
          { key: "escalate", n: 1 },
        ],
        fromCache: false,
      });

    const summary = await summarizeDecisions("ws_9");

    expect(summary.total).toBe(7);
    expect(summary.would_block).toBe(2);
    expect(summary.by_tier).toEqual({ low: 4, high: 2, critical: 1 });
    expect(summary.by_outcome).toEqual({ allow: 5, deny: 1, escalate: 1 });

    // Every call is workspace-scoped on $1 = "ws_9".
    expect(mockSafeQuery).toHaveBeenCalledTimes(3);
    for (const call of mockSafeQuery.mock.calls) {
      expect(String(call[0])).toContain("WHERE workspace_id = $1");
      expect(call[1]).toEqual(["ws_9"]);
    }
    // The totals query uses the FILTER aggregate for would_block.
    expect(String(mockSafeQuery.mock.calls[0][0])).toContain("FILTER (WHERE would_block)");
  });

  it("degrades to zeroes when the ledger is empty / unavailable", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [], fromCache: true });
    const summary = await summarizeDecisions("ws_empty");
    expect(summary).toEqual({ total: 0, would_block: 0, by_tier: {}, by_outcome: {} });
  });

  it("coerces string counts from pg into numbers", async () => {
    mockSafeQuery
      .mockResolvedValueOnce({ rows: [{ total: "3", would_block: "1" }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ key: "medium", n: "3" }], fromCache: false })
      .mockResolvedValueOnce({ rows: [{ key: "transform", n: "3" }], fromCache: false });
    const summary = await summarizeDecisions("ws_1");
    expect(summary.total).toBe(3);
    expect(summary.would_block).toBe(1);
    expect(summary.by_tier).toEqual({ medium: 3 });
    expect(summary.by_outcome).toEqual({ transform: 3 });
  });
});

/**
 * aggregate_external_records — intent + execution tests.
 */

const mockBuildRest = jest.fn();
const mockPickConfigured = jest.fn();
const mockTrackEvent = jest.fn();
jest.mock("@/lib/assistant/connectors", () => ({
  buildRestConnectorForWorkspace: (...a: any[]) => mockBuildRest(...a),
  pickConfiguredConnector: (...a: any[]) => mockPickConfigured(...a),
}));
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: any[]) => mockTrackEvent(...a),
}));

import { aggregateExternalRecordsTool } from "@/lib/assistant/tools/aggregate-external-records-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockPickConfigured.mockResolvedValue("salesforce");
});

describe("matchIntent — count", () => {
  test("'how many deals' → count on deal", () => {
    const p = aggregateExternalRecordsTool.matchIntent("how many deals");
    expect(p?.operation).toBe("count");
    expect(p?.objectType).toBe("deal");
  });

  test("'count of contacts' → count on contact", () => {
    const p = aggregateExternalRecordsTool.matchIntent("count of contacts");
    expect(p?.operation).toBe("count");
    expect(p?.objectType).toBe("contact");
  });

  test("'how many deals over $50k closing this month' captures filters", () => {
    const p = aggregateExternalRecordsTool.matchIntent("how many deals over $50k closing this month");
    expect(p?.operation).toBe("count");
    expect(p?.filters?.amount).toEqual({ op: "gt", value: 50000 });
    expect(p?.filters?.dateRange).toBe("this_month");
  });
});

describe("matchIntent — sum", () => {
  test("'total pipeline value' → sum on opportunity", () => {
    const p = aggregateExternalRecordsTool.matchIntent("total pipeline value");
    expect(p?.operation).toBe("sum");
    expect(p?.objectType).toBe("opportunity");
    expect(p?.field).toBe("Amount");
  });

  test("'pipeline value this quarter' → sum + date filter", () => {
    const p = aggregateExternalRecordsTool.matchIntent("pipeline value this quarter");
    expect(p?.operation).toBe("sum");
    expect(p?.filters?.dateRange).toBe("this_quarter");
  });

  test("'total amount of deals over $50k' → sum + amount filter", () => {
    const p = aggregateExternalRecordsTool.matchIntent("total amount of deals over $50k");
    expect(p?.operation).toBe("sum");
    expect(p?.filters?.amount?.value).toBe(50000);
  });
});

describe("matchIntent — avg", () => {
  test("'average deal size' → avg", () => {
    const p = aggregateExternalRecordsTool.matchIntent("average deal size");
    expect(p?.operation).toBe("avg");
    /* "deal" and "opportunity" both alias to SF Opportunity at the
       preset level — the param can be either. */
    expect(["deal", "opportunity"]).toContain(p?.objectType);
  });
});

describe("matchIntent — win rate", () => {
  test("'what's my win rate' → win_rate", () => {
    const p = aggregateExternalRecordsTool.matchIntent("what's my win rate");
    expect(p?.operation).toBe("win_rate");
    expect(p?.objectType).toBe("opportunity");
  });

  test("'win rate this quarter' captures date filter", () => {
    const p = aggregateExternalRecordsTool.matchIntent("win rate this quarter");
    expect(p?.operation).toBe("win_rate");
    expect(p?.filters?.dateRange).toBe("this_quarter");
  });
});

describe("matchIntent — top N", () => {
  test("'top 5 accounts by revenue'", () => {
    const p = aggregateExternalRecordsTool.matchIntent("top 5 accounts by revenue");
    expect(p?.operation).toBe("top");
    expect(p?.objectType).toBe("account");
    expect(p?.limit).toBe(5);
    expect(p?.field).toBe("AnnualRevenue");
  });

  test("'top 10 deals by amount'", () => {
    const p = aggregateExternalRecordsTool.matchIntent("top 10 deals by amount");
    expect(p?.limit).toBe(10);
    expect(p?.field).toBe("Amount");
  });

  test("'top 3 deals' (no field) defaults to Amount via preset", () => {
    const p = aggregateExternalRecordsTool.matchIntent("top 3 deals");
    expect(p?.operation).toBe("top");
    expect(p?.limit).toBe(3);
    expect(p?.field).toBeUndefined();
  });
});

describe("matchIntent — rejection", () => {
  test.each([
    "look up Grimace",
    "find the deal for Acme",
    "deals over $50k", // no aggregate verb
    "hi",
  ])("'%s' → null", (msg) => {
    expect(aggregateExternalRecordsTool.matchIntent(msg)).toBeNull();
  });
});

describe("handler — count", () => {
  test("renders count + filter description", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchAggregate: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: { type: "scalar", value: 17 },
        durationMs: 12,
      }),
    });
    const r = await aggregateExternalRecordsTool.handler(
      {
        objectType: "deal",
        operation: "count",
        filters: { amount: { op: "gt", value: 50000 }, dateRange: "this_month" },
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toContain("**17** deals");
      expect(r.answer).toContain("amount > $50,000");
      expect(r.answer).toContain("this month");
      /* Connector attribution is BOTH:
         1. in the typed data block (UI badge rendering, fresh messages)
         2. inline in the answer body as "*— Source: Salesforce*" (UI
            strips + renders badge; also survives transcript exports,
            conversation reload, analytics). */
      expect(r.data.connector).toBe("salesforce");
      expect(r.answer).toContain("*— Source: Salesforce*");
    }
  });
});

describe("handler — sum + avg formatting", () => {
  test("sum formats with M for >=1M", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchAggregate: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: { type: "scalar", value: 3_410_000 },
        durationMs: 8,
      }),
    });
    const r = await aggregateExternalRecordsTool.handler(
      { objectType: "deal", operation: "sum", field: "Amount", connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("$3.41M");
    expect(r.answer).toContain("Total");
  });

  test("avg formats with k for thousands", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchAggregate: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: { type: "scalar", value: 75_500 },
        durationMs: 8,
      }),
    });
    const r = await aggregateExternalRecordsTool.handler(
      { objectType: "deal", operation: "avg", field: "Amount", connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("$75.5k");
    expect(r.answer).toContain("Average");
  });
});

describe("handler — win rate", () => {
  test("renders percentage + breakdown", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchAggregate: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: { type: "rate", numerator: 7, denominator: 10 },
        durationMs: 5,
      }),
    });
    const r = await aggregateExternalRecordsTool.handler(
      { objectType: "opportunity", operation: "win_rate", connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("70.0%");
    expect(r.answer).toContain("7 won / 10 closed");
  });

  test("0 closed → 'undefined' message, no division by zero", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchAggregate: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: { type: "rate", numerator: 0, denominator: 0 },
        durationMs: 5,
      }),
    });
    const r = await aggregateExternalRecordsTool.handler(
      { objectType: "opportunity", operation: "win_rate", connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("undefined");
    expect(r.answer).not.toContain("NaN");
  });
});

describe("handler — top N", () => {
  test("renders numbered list with field values", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchAggregate: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: {
          type: "list",
          rows: [
            { Id: "001a", Name: "Acme Industries", AnnualRevenue: 5_000_000 },
            { Id: "001b", Name: "Burlington", AnnualRevenue: 2_500_000 },
          ],
        },
        durationMs: 10,
      }),
    });
    const r = await aggregateExternalRecordsTool.handler(
      { objectType: "account", operation: "top", field: "AnnualRevenue", limit: 5, connector: "rest-default" },
      ctx,
    );
    if (!r.ok) throw new Error("expected ok");
    expect(r.answer).toContain("Top 2 accounts");
    expect(r.answer).toContain("Acme Industries");
    expect(r.answer).toContain("$5.00M");
    expect(r.answer).toContain("$2.50M");
  });
});

describe("handler — analytics + safety", () => {
  test("fires connector_aggregate_executed event", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchAggregate: jest.fn().mockResolvedValueOnce({
        ok: true, data: { type: "scalar", value: 5 }, durationMs: 5,
      }),
    });
    await aggregateExternalRecordsTool.handler(
      { objectType: "deal", operation: "count", connector: "rest-default" },
      ctx,
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_aggregate_executed",
      "u1", "cto",
      expect.objectContaining({ operation: "count", result_type: "scalar" }),
    );
  });

  test("connector without searchAggregate → internal error", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      /* no searchAggregate */
    });
    const r = await aggregateExternalRecordsTool.handler(
      { objectType: "deal", operation: "count", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });

  test("auth_failed → tool capability error", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchAggregate: jest.fn().mockResolvedValueOnce({
        ok: false, code: "auth_failed", message: "HTTP 401",
      }),
    });
    const r = await aggregateExternalRecordsTool.handler(
      { objectType: "deal", operation: "count", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("capability");
  });
});

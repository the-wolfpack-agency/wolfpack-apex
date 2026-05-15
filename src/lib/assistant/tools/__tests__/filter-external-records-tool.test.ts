/**
 * filter_external_records — intent + execution tests.
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

import { filterExternalRecordsTool } from "@/lib/assistant/tools/filter-external-records-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockPickConfigured.mockResolvedValue("salesforce");
});

describe("matchIntent — amount filters", () => {
  test("'deals over $50k' → amount gt 50000", () => {
    const p = filterExternalRecordsTool.matchIntent("deals over $50k");
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("deal");
    expect(p?.filters.amount).toEqual({ op: "gt", value: 50000 });
  });

  test("'opportunities above 100000' → gt 100000", () => {
    const p = filterExternalRecordsTool.matchIntent("opportunities above 100000");
    expect(p?.filters.amount).toEqual({ op: "gt", value: 100000 });
  });

  test("'deals under $10k' → lt 10000", () => {
    const p = filterExternalRecordsTool.matchIntent("deals under $10k");
    expect(p?.filters.amount).toEqual({ op: "lt", value: 10000 });
  });

  test("'deals $1m or more' is NOT matched without an operator word", () => {
    /* The tool requires an explicit operator word; ambiguous phrasing
       falls through to the LLM. */
    expect(filterExternalRecordsTool.matchIntent("deals $1m or more")).toBeNull();
  });
});

describe("matchIntent — date filters", () => {
  test("'deals closing this month'", () => {
    const p = filterExternalRecordsTool.matchIntent("deals closing this month");
    expect(p?.filters.dateRange).toBe("this_month");
  });

  test("'opportunities closed last month'", () => {
    const p = filterExternalRecordsTool.matchIntent("opportunities closed last month");
    expect(p?.filters.dateRange).toBe("last_month");
  });

  test("'deals this quarter'", () => {
    const p = filterExternalRecordsTool.matchIntent("deals this quarter");
    expect(p?.filters.dateRange).toBe("this_quarter");
  });
});

describe("matchIntent — stage filters", () => {
  test("'deals stuck in Proposal'", () => {
    const p = filterExternalRecordsTool.matchIntent("deals stuck in Proposal");
    expect(p?.filters.stage).toBe("Proposal");
  });

  test("'opportunities in Closed Won'", () => {
    const p = filterExternalRecordsTool.matchIntent("opportunities in Closed Won");
    expect(p?.filters.stage).toBe("Closed Won");
  });
});

describe("matchIntent — combined filters", () => {
  test("'deals over $50k closing this month'", () => {
    const p = filterExternalRecordsTool.matchIntent("deals over $50k closing this month");
    expect(p).not.toBeNull();
    expect(p?.filters.amount).toEqual({ op: "gt", value: 50000 });
    expect(p?.filters.dateRange).toBe("this_month");
  });

  test("'deals over $50k in Proposal' (amount + stage)", () => {
    const p = filterExternalRecordsTool.matchIntent("deals over $50k in Proposal");
    expect(p?.filters.amount?.value).toBe(50000);
    expect(p?.filters.stage).toBe("Proposal");
  });
});

describe("matchIntent — rejection", () => {
  test.each([
    "find Grimace",
    "look up contact id 003abc",
    "deals", // no filter signal
    "this month", // no object type
    "hi",
  ])("'%s' → null", (msg) => {
    expect(filterExternalRecordsTool.matchIntent(msg)).toBeNull();
  });
});

describe("handler — execution", () => {
  test("happy path renders top results with stage + amount", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchFiltered: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: [
          { Id: "006a", Name: "Acme Renewal", StageName: "Proposal", Amount: 75000, CloseDate: "2026-09-15" },
          { Id: "006b", Name: "Beta Expansion", StageName: "Negotiation", Amount: 60000, CloseDate: "2026-09-22" },
        ],
        durationMs: 18,
      }),
    });
    const r = await filterExternalRecordsTool.handler(
      {
        objectType: "deal",
        filters: { amount: { op: "gt", value: 50000 }, dateRange: "this_month" },
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.matchCount).toBe(2);
      expect(r.answer).toContain("Acme Renewal");
      expect(r.answer).toContain("$75000");
      expect(r.answer).toContain("amount > $50,000");
      expect(r.answer).toContain("this month");
    }
  });

  test("0 matches renders description-aware message", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchFiltered: jest.fn().mockResolvedValueOnce({ ok: true, data: [], durationMs: 5 }),
    });
    const r = await filterExternalRecordsTool.handler(
      {
        objectType: "deal",
        filters: { stage: "Proposal" },
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("No deals matched");
  });

  test("auth_failed → tool capability error", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchFiltered: jest.fn().mockResolvedValueOnce({
        ok: false,
        code: "auth_failed",
        message: "HTTP 401",
      }),
    });
    const r = await filterExternalRecordsTool.handler(
      {
        objectType: "deal",
        filters: { amount: { op: "gt", value: 100 } },
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("capability");
  });

  test("analytics event flags which filter clauses were present", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchFiltered: jest.fn().mockResolvedValueOnce({ ok: true, data: [], durationMs: 5 }),
    });
    await filterExternalRecordsTool.handler(
      {
        objectType: "deal",
        filters: { amount: { op: "gt", value: 50000 }, dateRange: "this_month" },
        connector: "rest-default",
      },
      ctx,
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_filter_executed",
      "u1",
      "cto",
      expect.objectContaining({
        has_amount: true,
        has_date: true,
        has_stage: false,
        has_owner: false,
      }),
    );
  });
});

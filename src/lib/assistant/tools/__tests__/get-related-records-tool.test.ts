/**
 * get_related_records — intent + execution tests.
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

import { getRelatedRecordsTool } from "@/lib/assistant/tools/get-related-records-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockPickConfigured.mockResolvedValue("salesforce");
});

describe("matchIntent — possessive phrasing", () => {
  test("'Acme's opportunities' → account parent + opportunity related", () => {
    const p = getRelatedRecordsTool.matchIntent("Acme's opportunities");
    expect(p).not.toBeNull();
    expect(p?.parentType).toBe("contact");
    expect(p?.parentName).toBe("Acme");
    expect(p?.relatedType).toBe("opportunity");
  });

  test("multi-word parent → account inferred", () => {
    const p = getRelatedRecordsTool.matchIntent("Acme Industries's open deals");
    expect(p?.parentType).toBe("account");
    expect(p?.parentName).toBe("Acme Industries");
    expect(p?.relatedType).toBe("deal");
  });

  test("'Jorge's deals' → contact parent + deal related", () => {
    const p = getRelatedRecordsTool.matchIntent("Jorge's deals");
    expect(p?.parentType).toBe("contact");
    expect(p?.parentName).toBe("Jorge");
  });

  test("'show me Acme's contacts'", () => {
    const p = getRelatedRecordsTool.matchIntent("show me Acme's contacts");
    expect(p?.parentName).toBe("Acme");
    expect(p?.relatedType).toBe("contact");
  });
});

describe("matchIntent — owner phrasing", () => {
  test("'what deals does Jorge own' → contact + deal", () => {
    const p = getRelatedRecordsTool.matchIntent("what deals does Jorge own");
    expect(p?.parentType).toBe("contact");
    expect(p?.parentName).toBe("Jorge");
    expect(p?.relatedType).toBe("deal");
  });
});

describe("matchIntent — 'for' phrasing", () => {
  test("'show me opportunities for Acme'", () => {
    const p = getRelatedRecordsTool.matchIntent("show me opportunities for Acme");
    expect(p?.parentName).toBe("Acme");
    expect(p?.relatedType).toBe("opportunity");
  });
});

describe("matchIntent — rejection", () => {
  test.each([
    "look up Grimace Fromcdonalds",
    "create a contact",
    "hi",
    "what's on my calendar",
  ])("'%s' → null", (msg) => {
    expect(getRelatedRecordsTool.matchIntent(msg)).toBeNull();
  });
});

describe("handler — happy path", () => {
  test("returns 1-match render", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRelated: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: [
          { Id: "006abc", Name: "Acme Q3 Renewal", StageName: "Proposal", Amount: 50000 },
        ],
        durationMs: 12,
      }),
    });
    const r = await getRelatedRecordsTool.handler(
      {
        parentType: "account",
        parentName: "Acme",
        relatedType: "opportunity",
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.matchCount).toBe(1);
      expect(r.answer).toContain("Acme Q3 Renewal");
      expect(r.answer).toContain("Proposal");
      expect(r.answer).toContain("$50000");
    }
  });

  test("0 matches → 'no opportunities found'", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRelated: jest.fn().mockResolvedValueOnce({ ok: true, data: [], durationMs: 5 }),
    });
    const r = await getRelatedRecordsTool.handler(
      {
        parentType: "account",
        parentName: "Acme",
        relatedType: "opportunity",
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("No opportunitys found");
  });

  test("connector without searchRelated → internal error", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      /* no searchRelated */
    });
    const r = await getRelatedRecordsTool.handler(
      {
        parentType: "account",
        parentName: "Acme",
        relatedType: "opportunity",
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });

  test("fires assistant.connector_related_executed analytics", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRelated: jest.fn().mockResolvedValueOnce({ ok: true, data: [], durationMs: 5 }),
    });
    await getRelatedRecordsTool.handler(
      {
        parentType: "account",
        parentName: "Acme",
        relatedType: "opportunity",
        connector: "rest-default",
      },
      ctx,
    );
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_related_executed",
      "u1",
      "cto",
      expect.objectContaining({ parent_type: "account", related_type: "opportunity" }),
    );
  });
});

/**
 * update_external_record tool — intent + execution tests.
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

import {
  updateExternalRecordTool,
  executeUpdateExternalRecord,
  describeUpdateAction,
} from "@/lib/assistant/tools/update-external-record-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockPickConfigured.mockResolvedValue("salesforce");
});

describe("matchIntent — stage moves", () => {
  test("'move the Acme Renewal to Closed Won' → StageName update", () => {
    const p = updateExternalRecordTool.matchIntent("move the Acme Renewal to Closed Won");
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("deal");
    expect(p?.recordName).toBe("Acme Renewal");
    expect(p?.fieldName).toBe("StageName");
    expect(p?.fieldValue).toBe("Closed Won");
  });

  test("'move deal Q3 to stage Proposal' captures stage", () => {
    const p = updateExternalRecordTool.matchIntent("move deal Q3 to stage Proposal");
    expect(p?.fieldName).toBe("StageName");
    expect(p?.fieldValue).toBe("Proposal");
  });
});

describe("matchIntent — generic update phrasing", () => {
  test("'update the contact Jorge's phone to 555-0101'", () => {
    const p = updateExternalRecordTool.matchIntent(
      "update the contact Jorge's phone to 555-0101",
    );
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("contact");
    expect(p?.recordName).toBe("Jorge");
    expect(p?.fieldName).toBe("Phone");
    expect(p?.fieldValue).toBe("555-0101");
  });

  test("'update the opportunity Q3 Renewal's amount to 75000' coerces numeric", () => {
    const p = updateExternalRecordTool.matchIntent(
      "update the opportunity Q3 Renewal's amount to 75000",
    );
    expect(p?.fieldName).toBe("Amount");
    expect(p?.fieldValue).toBe(75000);
  });

  test("'set Jorge's email to jorge@new.com'", () => {
    const p = updateExternalRecordTool.matchIntent("set Jorge's email to jorge@new.com");
    expect(p?.objectType).toBe("contact");
    expect(p?.fieldName).toBe("Email");
    expect(p?.fieldValue).toBe("jorge@new.com");
  });

  test("'$50k' coerces to 50000", () => {
    const p = updateExternalRecordTool.matchIntent(
      "update the deal Q3 Renewal's amount to $50k",
    );
    expect(p?.fieldValue).toBe(50000);
  });
});

describe("matchIntent — rejection", () => {
  test.each([
    "look up Grimace",
    "create a contact named Jane",
    "what meetings do I have Monday",
    "hi",
  ])("'%s' → null", (msg) => {
    expect(updateExternalRecordTool.matchIntent(msg)).toBeNull();
  });
});

describe("tool definition", () => {
  test("requiresConfirmation is true", () => {
    expect(updateExternalRecordTool.requiresConfirmation).toBe(true);
  });

  test("handler returns preview without executing", async () => {
    const r = await updateExternalRecordTool.handler(
      {
        objectType: "deal",
        recordName: "Acme Renewal",
        fieldName: "StageName",
        fieldValue: "Closed Won",
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer.toLowerCase()).toContain("will update");
      expect(r.answer).toContain("Acme Renewal");
      expect(r.answer).toContain("Closed Won");
    }
  });

  test("describeUpdateAction is concise + informative", () => {
    const text = describeUpdateAction({
      objectType: "deal",
      recordName: "Q3 Renewal",
      fieldName: "StageName",
      fieldValue: "Closed Won",
      connector: "rest-default",
    });
    expect(text).toBe('update deal "Q3 Renewal" → StageName = Closed Won');
  });
});

describe("executeUpdateExternalRecord — happy path", () => {
  test("resolves name → id via search, then PATCHes the field", async () => {
    const mockSearch = jest.fn().mockResolvedValueOnce({
      ok: true,
      data: [{ Id: "006abc", Name: "Acme Renewal" }],
      durationMs: 5,
    });
    const mockUpdate = jest.fn().mockResolvedValueOnce({
      ok: true,
      data: { id: "006abc" },
      durationMs: 8,
    });
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: mockSearch,
      updateRecord: mockUpdate,
    });

    const r = await executeUpdateExternalRecord(
      {
        objectType: "deal",
        recordName: "Acme Renewal",
        fieldName: "StageName",
        fieldValue: "Closed Won",
        connector: "rest-default",
      },
      ctx,
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id).toBe("006abc");
      expect(r.connector).toBe("salesforce");
    }
    expect(mockSearch).toHaveBeenCalledWith("deal", "Acme Renewal", 5);
    expect(mockUpdate).toHaveBeenCalledWith("deal", "006abc", { StageName: "Closed Won" });
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_write_executed",
      "u1",
      "cto",
      expect.objectContaining({ op: "update", field_name: "StageName", ok: true }),
    );
  });

  test("opportunity → deal alias for search lookup", async () => {
    const mockSearch = jest.fn().mockResolvedValueOnce({
      ok: true,
      data: [{ Id: "006abc" }],
      durationMs: 5,
    });
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: mockSearch,
      updateRecord: jest.fn().mockResolvedValueOnce({ ok: true, data: { id: "006abc" } }),
    });
    await executeUpdateExternalRecord(
      {
        objectType: "opportunity",
        recordName: "Q3",
        fieldName: "StageName",
        fieldValue: "Closed Won",
        connector: "rest-default",
      },
      ctx,
    );
    expect(mockSearch.mock.calls[0][0]).toBe("deal");
  });
});

describe("executeUpdateExternalRecord — safety refusals", () => {
  test("0 matches → refuse + return no_match_found", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: jest.fn().mockResolvedValueOnce({ ok: true, data: [], durationMs: 5 }),
      updateRecord: jest.fn(),
    });
    const r = await executeUpdateExternalRecord(
      {
        objectType: "deal",
        recordName: "Nonexistent",
        fieldName: "StageName",
        fieldValue: "Closed Won",
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("no_match_found");
      expect(r.matchCount).toBe(0);
    }
  });

  test("2+ matches → refuse as ambiguous (writes never fire on uncertain matches)", async () => {
    const mockUpdate = jest.fn();
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: jest.fn().mockResolvedValueOnce({
        ok: true,
        data: [{ Id: "006a" }, { Id: "006b" }, { Id: "006c" }],
        durationMs: 5,
      }),
      updateRecord: mockUpdate,
    });
    const r = await executeUpdateExternalRecord(
      {
        objectType: "deal",
        recordName: "Renewal",
        fieldName: "StageName",
        fieldValue: "Closed Won",
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe("ambiguous");
      expect(r.matchCount).toBe(3);
    }
    expect(mockUpdate).not.toHaveBeenCalled();
  });

  test("connector without updateRecord → returns reason", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      searchRecords: jest.fn(),
      /* No updateRecord. */
    });
    const r = await executeUpdateExternalRecord(
      {
        objectType: "deal",
        recordName: "Q3",
        fieldName: "StageName",
        fieldValue: "Closed Won",
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("does not support writes");
  });
});

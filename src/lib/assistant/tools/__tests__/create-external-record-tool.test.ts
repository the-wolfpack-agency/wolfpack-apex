/**
 * create_external_record tool — intent + execution tests.
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
  createExternalRecordTool,
  executeCreateExternalRecord,
  describeCreateAction,
} from "@/lib/assistant/tools/create-external-record-tool";

const ctx = { userId: "u1", userRole: "cto", workspaceId: "ws1" };

beforeEach(() => {
  jest.clearAllMocks();
  mockPickConfigured.mockResolvedValue("salesforce");
});

describe("matchIntent — contact", () => {
  test("'create a contact named Jane Doe email jane@acme.com phone 555-0101'", () => {
    const p = createExternalRecordTool.matchIntent(
      "create a contact named Jane Doe email jane@acme.com phone 555-0101",
    );
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("contact");
    expect(p?.fields.FirstName).toBe("Jane");
    expect(p?.fields.LastName).toBe("Doe");
    expect(p?.fields.Email).toBe("jane@acme.com");
    expect(String(p?.fields.Phone)).toContain("555-0101");
  });

  test("'add a new contact: Jorge Colon at Acme'", () => {
    const p = createExternalRecordTool.matchIntent("add a new contact: Jorge Colon at Acme");
    expect(p).not.toBeNull();
    expect(p?.fields.FirstName).toBe("Jorge");
    expect(p?.fields.LastName).toBe("Colon");
    expect(p?.fields.AccountName_hint).toBe("Acme");
  });

  test("single-name contact captures as LastName only", () => {
    const p = createExternalRecordTool.matchIntent(
      "create a contact named Grimace email g@mc.com",
    );
    expect(p).not.toBeNull();
    expect(p?.fields.LastName).toBe("Grimace");
    expect(p?.fields.FirstName).toBeUndefined();
  });
});

describe("matchIntent — deal/opportunity", () => {
  test("'create a $50k deal for Acme stage Discovery close 2026-09-01'", () => {
    const p = createExternalRecordTool.matchIntent(
      "create a $50k deal for Acme stage Discovery close 2026-09-01",
    );
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("deal");
    expect(p?.fields.Amount).toBe(50000);
    expect(p?.fields.StageName).toBe("Discovery");
    expect(p?.fields.CloseDate).toBe("2026-09-01");
  });

  test("date normalization MM/DD/YYYY → ISO", () => {
    const p = createExternalRecordTool.matchIntent(
      "create a deal Q3 Renewal amount 100000 close 9/1/2026",
    );
    expect(p?.fields.CloseDate).toBe("2026-09-01");
  });

  test("amount in 'k' shorthand", () => {
    const p = createExternalRecordTool.matchIntent(
      "create a deal Acme Expansion amount 75k stage Proposal",
    );
    expect(p?.fields.Amount).toBe(75000);
  });
});

describe("matchIntent — account", () => {
  test("'create the Acme Industries account industry Manufacturing'", () => {
    const p = createExternalRecordTool.matchIntent(
      "create the Acme Industries account industry Manufacturing",
    );
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("account");
    expect(p?.fields.Name).toBe("Acme Industries");
    expect(p?.fields.Industry).toBe("Manufacturing");
  });
});

describe("matchIntent — task", () => {
  test("'log a call with Jorge about pricing' sets Subject + Completed status", () => {
    const p = createExternalRecordTool.matchIntent("log a call with Jorge about pricing");
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("task");
    expect(String(p?.fields.Subject)).toContain("call");
    expect(String(p?.fields.Subject)).toContain("Jorge");
    expect(p?.fields.Status).toBe("Completed");
  });

  test("'create a task to follow up Friday' sets Open status", () => {
    const p = createExternalRecordTool.matchIntent("create a task to follow up Friday");
    expect(p).not.toBeNull();
    expect(p?.objectType).toBe("task");
    expect(p?.fields.Status).toBe("Open");
  });
});

describe("matchIntent — rejection", () => {
  test.each([
    "look up Grimace Fromcdonalds",
    "find the deal for Acme",
    "create a contact", // no fields parseable
    "hi",
  ])("'%s' → null", (msg) => {
    expect(createExternalRecordTool.matchIntent(msg)).toBeNull();
  });
});

describe("tool definition", () => {
  test("requiresConfirmation is true — writes must never silently fire", () => {
    expect(createExternalRecordTool.requiresConfirmation).toBe(true);
  });

  test("handler returns descriptive preview without executing", async () => {
    const r = await createExternalRecordTool.handler(
      {
        objectType: "contact",
        fields: { FirstName: "Jane", LastName: "Doe", Email: "j@d.com" },
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer.toLowerCase()).toContain("will create");
      expect(r.answer).toContain("Jane");
      expect(r.data.id).toBe("(pending confirmation)");
    }
  });

  test("describeCreateAction renders compact field list", () => {
    const text = describeCreateAction({
      objectType: "deal",
      fields: { Name: "Q3 Renewal", Amount: 50000, StageName: "Proposal" },
      connector: "rest-default",
    });
    expect(text).toContain("Opportunity");
    expect(text).toContain("Q3 Renewal");
    expect(text).toContain("Amount=50000");
  });
});

describe("executeCreateExternalRecord — happy path", () => {
  test("routes to salesforce, calls createRecord, returns new id", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      createRecord: async () => ({ ok: true, data: { id: "003abc" }, durationMs: 42 }),
    });

    const r = await executeCreateExternalRecord(
      {
        objectType: "contact",
        fields: { FirstName: "Jane", LastName: "Doe", Email: "j@d.com" },
        connector: "rest-default",
      },
      ctx,
    );

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.id).toBe("003abc");
      expect(r.connector).toBe("salesforce");
    }
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "assistant.connector_write_executed",
      "u1",
      "cto",
      expect.objectContaining({ op: "create", connector: "salesforce", ok: true }),
    );
  });

  test("strips _hint fields before sending to vendor (AccountName_hint)", async () => {
    const captureCreate = jest.fn().mockResolvedValueOnce({
      ok: true,
      data: { id: "003abc" },
      durationMs: 5,
    });
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      createRecord: captureCreate,
    });

    await executeCreateExternalRecord(
      {
        objectType: "contact",
        fields: { FirstName: "Jane", LastName: "Doe", AccountName_hint: "Acme" },
        connector: "rest-default",
      },
      ctx,
    );
    const sentFields = captureCreate.mock.calls[0][1] as Record<string, unknown>;
    expect(sentFields.FirstName).toBe("Jane");
    expect(sentFields.AccountName_hint).toBeUndefined();
  });
});

describe("executeCreateExternalRecord — failure modes", () => {
  test("not configured → returns reason", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => false,
      createRecord: jest.fn(),
    });
    const r = await executeCreateExternalRecord(
      {
        objectType: "contact",
        fields: { LastName: "Doe" },
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("not configured");
  });

  test("connector without createRecord → returns reason", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      /* No createRecord method. */
    });
    const r = await executeCreateExternalRecord(
      {
        objectType: "contact",
        fields: { LastName: "Doe" },
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("does not support writes");
  });

  test("vendor REQUIRED_FIELD_MISSING → returns vendor error message", async () => {
    mockBuildRest.mockResolvedValueOnce({
      isConfigured: () => true,
      createRecord: async () => ({
        ok: false,
        code: "remote_error",
        message: "HTTP 400: REQUIRED_FIELD_MISSING: LastName",
        durationMs: 10,
      }),
    });
    const r = await executeCreateExternalRecord(
      {
        objectType: "contact",
        fields: { FirstName: "Jane" },
        connector: "rest-default",
      },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain("REQUIRED_FIELD_MISSING");
  });
});

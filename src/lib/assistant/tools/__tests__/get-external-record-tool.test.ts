/**
 * Tests for the get_external_record tool.
 */

const mockGetConnector = jest.fn();
const mockBuildRest = jest.fn();
const mockPickConfigured = jest.fn();
jest.mock("@/lib/assistant/connectors", () => ({
  getConnector: (...a: any[]) => mockGetConnector(...a),
  buildRestConnectorForWorkspace: (...a: any[]) => mockBuildRest(...a),
  pickConfiguredConnector: (...a: any[]) => mockPickConfigured(...a),
}));

import { getExternalRecordTool } from "@/lib/assistant/tools/get-external-record-tool";

const ctx = { userId: "u1", userRole: "cto" };

beforeEach(() => {
  mockGetConnector.mockReset();
  mockBuildRest.mockReset();
  mockPickConfigured.mockReset();
  /* Default: no preferred vendor row configured (legacy single-workspace
     env-driven deploy). Tests that exercise the auto-routing path
     override this. */
  mockPickConfigured.mockResolvedValue(null);
});

/* The rest-default connector path runs through buildRestConnectorForWorkspace.
   Helper that points BOTH mocks at the same stub object so tests can
   ignore the routing detail. */
function stubBoth(stub: any): void {
  mockGetConnector.mockReturnValue(stub);
  mockBuildRest.mockResolvedValue(stub);
}

describe("get_external_record — intent matching", () => {
  test.each([
    ["look up contact id ABC-123", { objectType: "contact", id: "ABC-123" }],
    ["get the deal record for 7HJ-99", { objectType: "deal", id: "7HJ-99" }],
    ["find the company with id acme-corp in our CRM", { objectType: "company", id: "acme-corp" }],
    ["show me invoice INV-001", { objectType: "invoice", id: "INV-001" }],
    ["fetch payment id pay_xyz", { objectType: "payment", id: "pay_xyz" }],
  ])("matches '%s'", (msg, expected) => {
    const params = getExternalRecordTool.matchIntent(msg);
    expect(params).toMatchObject({ ...expected, connector: "rest-default" });
  });

  test.each([
    "what do we know about Acme",
    "hi",
    "show me the dashboard",
    "find emails from Max",
  ])("does NOT match '%s'", (msg) => {
    expect(getExternalRecordTool.matchIntent(msg)).toBeNull();
  });

  test("paramSchema rejects unknown object types", () => {
    expect(
      getExternalRecordTool.paramSchema.safeParse({
        objectType: "spaceship",
        id: "x",
        connector: "rest-default",
      }).success,
    ).toBe(false);
  });
});

describe("get_external_record — handler", () => {
  test("returns graceful 'not configured' answer when connector exists but isn't set up", async () => {
    stubBoth({
      isConfigured: () => false,
      getRecord: async () => ({ ok: false }),
    });
    const r = await getExternalRecordTool.handler(
      { objectType: "contact", id: "abc", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer.toLowerCase()).toContain("isn't configured");
  });

  test("returns internal failure when connector isn't registered", async () => {
    mockGetConnector.mockReturnValueOnce(null);
    const r = await getExternalRecordTool.handler(
      { objectType: "contact", id: "abc", connector: "ghost" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });

  test("returns Markdown summary on a real fetched record", async () => {
    stubBoth({
      isConfigured: () => true,
      getRecord: async () => ({
        ok: true,
        data: { id: "abc", name: "Acme Inc.", status: "active", contact: "jorge@acme.com" },
        durationMs: 42,
      }),
    });
    const r = await getExternalRecordTool.handler(
      { objectType: "contact", id: "abc", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.answer).toContain("Acme Inc.");
      expect(r.answer).toContain("jorge@acme.com");
      expect(r.answer).toMatch(/^\*\*Contact\*\* `abc`/);
    }
  });

  test("returns 'no record found' when connector says not_found", async () => {
    stubBoth({
      isConfigured: () => true,
      getRecord: async () => ({ ok: false, code: "not_found", message: "no" }),
    });
    const r = await getExternalRecordTool.handler(
      { objectType: "deal", id: "missing", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.answer).toContain("No deal found");
  });

  test("maps connector auth_failed → tool capability failure", async () => {
    stubBoth({
      isConfigured: () => true,
      getRecord: async () => ({ ok: false, code: "auth_failed", message: "HTTP 401" }),
    });
    const r = await getExternalRecordTool.handler(
      { objectType: "contact", id: "abc", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("capability");
  });

  test("maps other connector errors → tool internal failure", async () => {
    stubBoth({
      isConfigured: () => true,
      getRecord: async () => ({ ok: false, code: "remote_error", message: "HTTP 500" }),
    });
    const r = await getExternalRecordTool.handler(
      { objectType: "contact", id: "abc", connector: "rest-default" },
      ctx,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("internal");
  });
});

/* ---------------------------------------------------------------------
 * Regression 2026-05-15: tool defaulted to connector="rest-default"
 * (the intent regex's only output) but the workspace had OAuth creds
 * stored under "salesforce". User saw "rest-default isn't configured"
 * even though Salesforce was fully wired. The tool now asks
 * pickConfiguredConnector for the best match.
 * --------------------------------------------------------------- */
describe("get_external_record — auto-routing to vendor-configured connector", () => {
  test("when workspace has a salesforce row, default rest-default routes to salesforce", async () => {
    mockPickConfigured.mockResolvedValueOnce("salesforce");
    const sfStub = {
      isConfigured: () => true,
      getRecord: async () => ({
        ok: true,
        data: { Id: "003abc", Name: "Grimace Fromcdonalds", Email: "g@mc.dev" },
        durationMs: 12,
      }),
    };
    mockBuildRest.mockResolvedValueOnce(sfStub);

    const r = await getExternalRecordTool.handler(
      { objectType: "contact", id: "003abc", connector: "rest-default" },
      { ...ctx, workspaceId: "ws1" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      /* The data block carries the RESOLVED connector name. The user-
         visible answer references the actual Salesforce record. */
      expect(r.data.connector).toBe("salesforce");
      expect(r.answer).toContain("Grimace Fromcdonalds");
    }
    /* buildRestConnectorForWorkspace was called with the resolved name,
       NOT "rest-default". This is the actual contract change. */
    expect(mockBuildRest).toHaveBeenCalledWith("ws1", "salesforce");
  });

  test("when workspace has no vendor row, falls back to rest-default", async () => {
    mockPickConfigured.mockResolvedValueOnce(null);
    stubBoth({
      isConfigured: () => true,
      getRecord: async () => ({ ok: true, data: { id: "x" }, durationMs: 1 }),
    });
    await getExternalRecordTool.handler(
      { objectType: "contact", id: "x", connector: "rest-default" },
      { ...ctx, workspaceId: "ws-no-creds" },
    );
    expect(mockBuildRest).toHaveBeenCalledWith("ws-no-creds", "rest-default");
  });

  test("when pickConfiguredConnector returns rest-default explicitly, no change", async () => {
    mockPickConfigured.mockResolvedValueOnce("rest-default");
    stubBoth({
      isConfigured: () => true,
      getRecord: async () => ({ ok: true, data: {}, durationMs: 1 }),
    });
    await getExternalRecordTool.handler(
      { objectType: "contact", id: "x", connector: "rest-default" },
      { ...ctx, workspaceId: "ws1" },
    );
    expect(mockBuildRest).toHaveBeenCalledWith("ws1", "rest-default");
  });

  test("explicit non-default connector param skips auto-routing", async () => {
    /* When the caller (or a future tool) passes connector="hubspot"
       directly, we honor it via getConnector and DON'T consult the
       picker — the explicit name is the source of truth. */
    mockGetConnector.mockReturnValue({
      isConfigured: () => true,
      getRecord: async () => ({ ok: true, data: { id: "x" }, durationMs: 1 }),
    });
    await getExternalRecordTool.handler(
      { objectType: "contact", id: "x", connector: "hubspot" },
      { ...ctx, workspaceId: "ws1" },
    );
    expect(mockPickConfigured).not.toHaveBeenCalled();
    expect(mockGetConnector).toHaveBeenCalledWith("hubspot");
  });
});

/**
 * Least-privilege enforcement at the AGENT action path, proven through a real
 * connector tool (search_external_records) + the shared resolver.
 *
 * This is the proof the binding is now the GATE:
 *   - An agent bound ONLY to "salesforce" is DENIED for an unbound connector
 *     ("jira") both ways:
 *       (a) explicit params.connector = "jira"
 *       (b) implicit pick (params.connector = "rest-default") when the workspace
 *           would otherwise auto-route to a connector the agent isn't bound to.
 *     In both cases NO connector is built and the scope-denied event fires.
 *   - The same agent is ALLOWED for "salesforce".
 *   - An agent with NO bindings cannot use any connector.
 *   - CRITICALLY: a call with NO agentPrincipal (the human assistant) is
 *     UNCHANGED — it picks + builds connectors exactly as before, never touching
 *     the binding store.
 *
 * We mock the connectors barrel (so no network / DB) and the binding store
 * (listAgentConnectionNames) that scope.ts reads. trackEvent is mocked to assert
 * the deny telemetry. recordAudit is mocked to a no-op.
 */

const mockGetConnector = jest.fn();
const mockBuildRest = jest.fn();
const mockPickConfigured = jest.fn();
jest.mock("@/lib/assistant/connectors", () => ({
  getConnector: (...a: unknown[]) => mockGetConnector(...a),
  buildRestConnectorForWorkspace: (...a: unknown[]) => mockBuildRest(...a),
  pickConfiguredConnector: (...a: unknown[]) => mockPickConfigured(...a),
}));

const mockListNames = jest.fn();
jest.mock("@/lib/agents/connections/store", () => ({
  listAgentConnectionNames: (...a: unknown[]) => mockListNames(...a),
}));

const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

jest.mock("@/lib/audit-log", () => ({
  recordAudit: jest.fn().mockResolvedValue({ id: "a", seq: 1, entryHash: "h" }),
}));

import { searchExternalRecordsTool } from "@/lib/assistant/tools/search-external-records-tool";

/** A connector stub that returns one record on search. */
function okConnector() {
  return {
    isConfigured: () => true,
    searchRecords: async () => ({
      ok: true,
      data: [{ Id: "003a", Name: "Grimace", Email: "g@mc.com" }],
      durationMs: 5,
    }),
  };
}

const AGENT_CTX = {
  userId: "agent-1",
  userRole: "sales",
  workspaceId: "ws-1",
  agentPrincipal: {
    agentId: "agent-1",
    role: "sales",
    workspaceId: "ws-1",
    ownerUserId: "owner-1",
  },
};

const HUMAN_CTX = { userId: "u1", userRole: "cto", workspaceId: "ws-1" };

beforeEach(() => {
  mockGetConnector.mockReset();
  mockBuildRest.mockReset();
  mockPickConfigured.mockReset();
  mockListNames.mockReset();
  mockTrackEvent.mockReset();
});

describe("agent bound ONLY to salesforce", () => {
  beforeEach(() => mockListNames.mockResolvedValue(["salesforce"]));

  it("DENIES an explicit unbound connector (jira) — no connector built, deny event fires", async () => {
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", list: false, connector: "jira" },
      AGENT_CTX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("connector_not_authorized");
    /* The gate fired before any connector resolution. */
    expect(mockGetConnector).not.toHaveBeenCalled();
    expect(mockBuildRest).not.toHaveBeenCalled();
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.connector_scope_denied",
      "agent-1",
      "sales",
      { connector: "jira", workspace_id: "ws-1" },
    );
  });

  it("DENIES the implicit pick when it would route to an unbound connector", async () => {
    /* The workspace would auto-route to hubspot, but the agent is bound only to
       salesforce → the agent-aware pick returns null → deny, nothing built. */
    mockPickConfigured.mockResolvedValue(null);
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", list: false, connector: "rest-default" },
      AGENT_CTX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("connector_not_authorized");
    expect(mockBuildRest).not.toHaveBeenCalled();
    /* pick WAS consulted, agent-scoped (second arg = agentId). */
    expect(mockPickConfigured).toHaveBeenCalledWith("ws-1", "agent-1");
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.connector_scope_denied",
      "agent-1",
      "sales",
      expect.objectContaining({ connector: "rest-default", workspace_id: "ws-1" }),
    );
  });

  it("ALLOWS the bound connector (explicit salesforce) — connector built, search runs", async () => {
    mockGetConnector.mockReturnValue(okConnector());
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", list: false, connector: "salesforce" },
      AGENT_CTX,
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.data.connector).toBe("salesforce");
      expect(r.data.matchCount).toBe(1);
    }
    /* No scope-denied event on the allow path. */
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "agent.connector_scope_denied",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("ALLOWS the bound connector via implicit pick (rest-default → salesforce)", async () => {
    mockPickConfigured.mockResolvedValue("salesforce");
    mockBuildRest.mockResolvedValue(okConnector());
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", list: false, connector: "rest-default" },
      AGENT_CTX,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.connector).toBe("salesforce");
    /* build called WITH the agentId as third arg (scoped). */
    expect(mockBuildRest).toHaveBeenCalledWith("ws-1", "salesforce", "agent-1");
  });
});

describe("agent with NO bindings", () => {
  beforeEach(() => mockListNames.mockResolvedValue([]));

  it("cannot use an explicit connector", async () => {
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", list: false, connector: "salesforce" },
      AGENT_CTX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("connector_not_authorized");
    expect(mockBuildRest).not.toHaveBeenCalled();
    expect(mockGetConnector).not.toHaveBeenCalled();
  });

  it("cannot use the implicit pick", async () => {
    mockPickConfigured.mockResolvedValue(null);
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", list: false, connector: "rest-default" },
      AGENT_CTX,
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("connector_not_authorized");
    expect(mockBuildRest).not.toHaveBeenCalled();
  });
});

describe("human assistant (no agentPrincipal) — UNCHANGED", () => {
  it("picks + builds connectors exactly as before, NEVER touching the binding store", async () => {
    mockPickConfigured.mockResolvedValue("salesforce");
    mockBuildRest.mockResolvedValue(okConnector());
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", list: false, connector: "rest-default" },
      HUMAN_CTX,
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.connector).toBe("salesforce");
    /* The binding store is never consulted on a human turn. */
    expect(mockListNames).not.toHaveBeenCalled();
    /* No scope-denied telemetry ever fires for a human. */
    expect(mockTrackEvent).not.toHaveBeenCalledWith(
      "agent.connector_scope_denied",
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
    /* Byte-for-byte call shape: pick(ws) + build(ws, name) with NO third arg. */
    expect(mockPickConfigured).toHaveBeenCalledWith("ws-1");
    expect(mockBuildRest).toHaveBeenCalledWith("ws-1", "salesforce");
  });

  it("explicit connector on a human turn resolves via getConnector, no store lookup", async () => {
    mockGetConnector.mockReturnValue(okConnector());
    const r = await searchExternalRecordsTool.handler(
      { objectType: "contact", query: "Grimace", list: false, connector: "hubspot" },
      HUMAN_CTX,
    );
    expect(r.ok).toBe(true);
    expect(mockGetConnector).toHaveBeenCalledWith("hubspot");
    expect(mockListNames).not.toHaveBeenCalled();
  });
});

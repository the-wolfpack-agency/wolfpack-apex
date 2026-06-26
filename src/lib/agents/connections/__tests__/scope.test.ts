/**
 * Least-privilege scope helper tests (src/lib/agents/connections/scope.ts).
 *
 * The binding store records agent↔connector associations; this module turns the
 * binding into the GATE. We assert:
 *   - allowed iff connectorName ∈ the agent's bound set.
 *   - a denial emits agent.connector_scope_denied (analytics) + best-effort
 *     recordAudit, and never throws even if audit fails.
 *   - the assistant sentinel principal is ALWAYS allowed (not a real agent).
 *   - agentBoundConnectors re-exports the bound list.
 */

const mockListNames = jest.fn();
jest.mock("@/lib/agents/connections/store", () => ({
  listAgentConnectionNames: (...a: unknown[]) => mockListNames(...a),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));
const mockRecordAudit = jest.fn();
jest.mock("@/lib/audit-log", () => ({
  recordAudit: (...a: unknown[]) => mockRecordAudit(...a),
}));

import {
  assertAgentConnectorScope,
  agentBoundConnectors,
  ASSISTANT_SENTINEL,
} from "@/lib/agents/connections/scope";

beforeEach(() => {
  mockListNames.mockReset();
  mockTrackEvent.mockReset();
  mockRecordAudit.mockReset();
  mockRecordAudit.mockResolvedValue({ id: "a", seq: 1, entryHash: "h" });
});

describe("assertAgentConnectorScope", () => {
  it("ALLOWS a connector in the agent's bound set; no deny event", async () => {
    mockListNames.mockResolvedValue(["salesforce"]);
    const { allowed } = await assertAgentConnectorScope("agent-1", "ws-1", "salesforce", "sales");
    expect(allowed).toBe(true);
    expect(mockTrackEvent).not.toHaveBeenCalled();
    expect(mockRecordAudit).not.toHaveBeenCalled();
  });

  it("DENIES a connector NOT in the bound set; emits analytics + audit", async () => {
    mockListNames.mockResolvedValue(["salesforce"]);
    const { allowed } = await assertAgentConnectorScope("agent-1", "ws-1", "jira", "sales");
    expect(allowed).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.connector_scope_denied",
      "agent-1",
      "sales",
      { connector: "jira", workspace_id: "ws-1" },
    );
    expect(mockRecordAudit).toHaveBeenCalledTimes(1);
    const auditArg = mockRecordAudit.mock.calls[0][0];
    expect(auditArg.action).toBe("agent.connector.scope_denied");
    expect(auditArg.resourceType).toBe("agent_connection");
    expect(auditArg.resourceId).toBe("agent-1");
  });

  it("DENIES when the agent has NO bindings at all", async () => {
    mockListNames.mockResolvedValue([]);
    const { allowed } = await assertAgentConnectorScope("agent-1", "ws-1", "salesforce");
    expect(allowed).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
  });

  it("ALWAYS allows the assistant sentinel without touching the store", async () => {
    const { allowed } = await assertAgentConnectorScope(ASSISTANT_SENTINEL, "ws-1", "jira");
    expect(allowed).toBe(true);
    expect(mockListNames).not.toHaveBeenCalled();
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it("does not throw when recordAudit fails (deny is still returned + tracked)", async () => {
    mockListNames.mockResolvedValue(["salesforce"]);
    mockRecordAudit.mockRejectedValue(new Error("audit chain down"));
    const { allowed } = await assertAgentConnectorScope("agent-1", "ws-1", "jira");
    expect(allowed).toBe(false);
    expect(mockTrackEvent).toHaveBeenCalledTimes(1);
  });
});

describe("agentBoundConnectors", () => {
  it("returns the agent's bound connector names", async () => {
    mockListNames.mockResolvedValue(["salesforce", "hubspot"]);
    const names = await agentBoundConnectors("ws-1", "agent-1");
    expect(names).toEqual(["salesforce", "hubspot"]);
    expect(mockListNames).toHaveBeenCalledWith("ws-1", "agent-1");
  });
});

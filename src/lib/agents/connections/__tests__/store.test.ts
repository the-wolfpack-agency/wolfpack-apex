/**
 * Agent↔connection association store tests (migration 183) against a mocked db.
 *
 *  - bindAgentConnection: idempotent (INSERT ... ON CONFLICT DO NOTHING),
 *    emits agent.connection_bound ONLY on a new row, returns whether created.
 *  - unbindAgentConnection: emits agent.connection_unbound ONLY when a row was
 *    removed, returns whether removed.
 *  - listAgentConnectionNames: returns the connector_names for one agent.
 *  - listConnectionsByAgent: groups agentId -> connector_names[] in one query.
 */

const mockSafeQuery = jest.fn();
const mockWriteQuery = jest.fn();
jest.mock("@/lib/db", () => ({
  safeQuery: (...a: unknown[]) => mockSafeQuery(...a),
  writeQuery: (...a: unknown[]) => mockWriteQuery(...a),
}));
const mockTrackEvent = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...a: unknown[]) => mockTrackEvent(...a),
}));

import {
  bindAgentConnection,
  unbindAgentConnection,
  listAgentConnectionNames,
  listConnectionsByAgent,
} from "@/lib/agents/connections/store";

beforeEach(() => {
  mockSafeQuery.mockReset();
  mockWriteQuery.mockReset();
  mockTrackEvent.mockReset();
});

describe("bindAgentConnection", () => {
  it("creates a row, returns true, and emits agent.connection_bound", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [{ id: "row-1" }] });
    const created = await bindAgentConnection({
      workspaceId: "ws-1",
      agentId: "agent-1",
      connectorName: "salesforce",
      createdBy: "admin-1",
    });
    expect(created).toBe(true);
    // Idempotent INSERT.
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(/ON CONFLICT/i);
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(/DO NOTHING/i);
    expect(mockWriteQuery.mock.calls[0][1]).toEqual([
      "ws-1",
      "agent-1",
      "salesforce",
      "admin-1",
    ]);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.connection_bound",
      "admin-1",
      "admin",
      { agent_id: "agent-1", connector_name: "salesforce" },
    );
  });

  it("is idempotent: a conflicting bind returns false and emits no event", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [] }); // ON CONFLICT DO NOTHING
    const created = await bindAgentConnection({
      workspaceId: "ws-1",
      agentId: "agent-1",
      connectorName: "salesforce",
      createdBy: "admin-1",
    });
    expect(created).toBe(false);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });

  it("defaults a blank workspace to 'default'", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [{ id: "row-1" }] });
    await bindAgentConnection({
      workspaceId: "",
      agentId: "agent-1",
      connectorName: "jira",
      createdBy: "admin-1",
    });
    expect(mockWriteQuery.mock.calls[0][1][0]).toBe("default");
  });
});

describe("unbindAgentConnection", () => {
  it("removes a row, returns true, and emits agent.connection_unbound", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [{ id: "row-1" }] });
    const removed = await unbindAgentConnection(
      "ws-1",
      "agent-1",
      "salesforce",
      "admin-1",
    );
    expect(removed).toBe(true);
    expect(mockWriteQuery.mock.calls[0][0]).toMatch(/DELETE FROM/i);
    expect(mockTrackEvent).toHaveBeenCalledWith(
      "agent.connection_unbound",
      "admin-1",
      "admin",
      { agent_id: "agent-1", connector_name: "salesforce" },
    );
  });

  it("returns false and emits no event when nothing was bound", async () => {
    mockWriteQuery.mockResolvedValue({ rows: [] });
    const removed = await unbindAgentConnection(
      "ws-1",
      "agent-1",
      "salesforce",
      "admin-1",
    );
    expect(removed).toBe(false);
    expect(mockTrackEvent).not.toHaveBeenCalled();
  });
});

describe("listAgentConnectionNames", () => {
  it("returns the connector_names bound to the agent", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [{ connector_name: "jira" }, { connector_name: "salesforce" }],
    });
    const names = await listAgentConnectionNames("ws-1", "agent-1");
    expect(names).toEqual(["jira", "salesforce"]);
    expect(mockSafeQuery.mock.calls[0][1]).toEqual(["ws-1", "agent-1"]);
  });

  it("returns [] when the agent has no bound connections", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await listAgentConnectionNames("ws-1", "agent-1")).toEqual([]);
  });
});

describe("listConnectionsByAgent", () => {
  it("groups connector_names by agent in a single query", async () => {
    mockSafeQuery.mockResolvedValue({
      rows: [
        { agent_id: "agent-1", connector_name: "jira" },
        { agent_id: "agent-1", connector_name: "salesforce" },
        { agent_id: "agent-2", connector_name: "github" },
      ],
    });
    const grouped = await listConnectionsByAgent("ws-1");
    expect(grouped).toEqual({
      "agent-1": ["jira", "salesforce"],
      "agent-2": ["github"],
    });
    // ONE query for the whole roster (no N+1).
    expect(mockSafeQuery).toHaveBeenCalledTimes(1);
  });

  it("returns {} when the workspace has no bound connections", async () => {
    mockSafeQuery.mockResolvedValue({ rows: [] });
    expect(await listConnectionsByAgent("ws-1")).toEqual({});
  });
});

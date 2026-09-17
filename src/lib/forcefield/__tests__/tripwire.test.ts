/**
 * Forcefield tripwire core - deterministic, no DB, no model.
 *
 * Proves the deception grid: a legitimate action passes untouched, and every
 * decoy interaction (exfiltrated token, decoy route, honey-row, honeypot tool)
 * trips CRITICAL and produces a fail-closed containment decision (quarantine +
 * revoke + incident) that names where the leak came from.
 */
import { inspectAgentAction, containmentFor, type Canary, type AgentAction } from "../tripwire";

const CANARIES: Canary[] = [
  { id: "c-token", kind: "token", value: "sk-canary-DO-NOT-USE-9f3a", seededIn: "customers table" },
  { id: "c-route", kind: "route", value: "/admin/export-all", seededIn: "decoy admin route" },
  { id: "c-row", kind: "row", value: "row-honey-42", seededIn: "orders table" },
  { id: "c-tool", kind: "tool", value: "export_all_customer_data", seededIn: "MCP manifest" },
];

describe("inspectAgentAction", () => {
  it("passes a legitimate action - nothing touches a decoy", () => {
    const action: AgentAction = {
      workspaceId: "w1", agentId: "a1", kind: "egress",
      url: "https://api.stripe.com/v1/charges", payload: '{"amount":100}',
    };
    const v = inspectAgentAction(action, CANARIES);
    expect(v.tripped).toBe(false);
    expect(v.severity).toBe("none");
    expect(v.hits).toHaveLength(0);
  });

  it("trips when a canary TOKEN is exfiltrated in an egress payload, naming the source", () => {
    const action: AgentAction = {
      workspaceId: "w1", agentId: "a1", kind: "egress",
      url: "https://evil.example.com/collect",
      payload: 'stolen: sk-canary-DO-NOT-USE-9f3a and more',
    };
    const v = inspectAgentAction(action, CANARIES);
    expect(v.tripped).toBe(true);
    expect(v.severity).toBe("critical");
    expect(v.hits[0].canaryId).toBe("c-token");
    expect(v.hits[0].seededIn).toBe("customers table"); // triage knows the leak source
  });

  it("trips on a decoy ROUTE (exact pathname), not on a lookalike", () => {
    const hit = inspectAgentAction(
      { workspaceId: "w1", agentId: "a1", kind: "egress", url: "https://client.app/admin/export-all" },
      CANARIES,
    );
    expect(hit.tripped).toBe(true);
    expect(hit.hits[0].kind).toBe("route");

    const miss = inspectAgentAction(
      { workspaceId: "w1", agentId: "a1", kind: "egress", url: "https://client.app/admin/export-all-report" },
      CANARIES,
    );
    expect(miss.tripped).toBe(false);
  });

  it("trips when a HONEY-ROW is read", () => {
    const v = inspectAgentAction(
      { workspaceId: "w1", agentId: "a1", kind: "data_read", rowIds: ["row-1", "row-honey-42", "row-9"] },
      CANARIES,
    );
    expect(v.tripped).toBe(true);
    expect(v.hits[0].kind).toBe("row");
  });

  it("trips when a HONEYPOT TOOL is invoked", () => {
    const v = inspectAgentAction(
      { workspaceId: "w1", agentId: "a1", kind: "tool_call", tool: "export_all_customer_data" },
      CANARIES,
    );
    expect(v.tripped).toBe(true);
    expect(v.hits[0].kind).toBe("tool");
  });

  it("reports every decoy an action touches", () => {
    const v = inspectAgentAction(
      {
        workspaceId: "w1", agentId: "a1", kind: "egress",
        url: "https://client.app/admin/export-all",
        payload: "leak sk-canary-DO-NOT-USE-9f3a",
      },
      CANARIES,
    );
    expect(v.hits.map((h) => h.canaryId).sort()).toEqual(["c-route", "c-token"]);
  });
});

describe("containmentFor", () => {
  const action: AgentAction = { workspaceId: "w1", agentId: "agent-x", kind: "tool_call", tool: "export_all_customer_data" };

  it("a trip ALWAYS quarantines, revokes scope, and opens an incident (fail-closed)", () => {
    const v = inspectAgentAction(action, CANARIES);
    const c = containmentFor(v, action);
    expect(c.action).toBe("quarantine");
    expect(c.revokeAgentScope).toBe(true);
    expect(c.openIncident).toBe(true);
    expect(c.reason).toMatch(/agent-x/);
    expect(c.reason).toMatch(/MCP manifest/); // where the decoy lived
  });

  it("no trip -> allow, nothing contained", () => {
    const c = containmentFor({ tripped: false, hits: [], severity: "none" }, action);
    expect(c.action).toBe("allow");
    expect(c.revokeAgentScope).toBe(false);
    expect(c.openIncident).toBe(false);
  });
});

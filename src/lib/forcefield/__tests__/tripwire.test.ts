/**
 * Forcefield tripwire core - deterministic, no DB, no model.
 *
 * Proves the deception grid: a legitimate action passes untouched, and every
 * decoy interaction (exfiltrated token, decoy route, honey-row, honeypot tool)
 * trips CRITICAL and produces a fail-closed containment decision (quarantine +
 * revoke + incident) that names where the leak came from.
 */
import { inspectAgentAction, containmentFor, containsDecoy, type Canary, type AgentAction } from "../tripwire";

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

/* Every canary kind is detectable where it would actually be USED. The
   production decoys are long random values; these mirror that shape. */
const LIVE: Canary[] = [
  { id: "t", kind: "token", value: "wlpk_live_3f9a1c2b7d4e5f60718293ab", seededIn: "JS bundle" },
  { id: "r", kind: "route", value: "/internal/export-9c1d2e3f4a5b6c7d8e9f0a1b", seededIn: "robots.txt" },
  { id: "w", kind: "row", value: "decoy-77aa88bb99cc00dd11ee22ff@example.invalid", seededIn: "customers API" },
  { id: "o", kind: "tool", value: "admin_bulk_export_5e6f7a8b9c0d1e2f3a4b5c6d", seededIn: "tool manifest" },
];
const trips = (a: Partial<AgentAction>) =>
  inspectAgentAction({ workspaceId: "w1", agentId: "a1", kind: "inbound_request", ...a } as AgentAction, LIVE).hits.map((h) => `${h.canaryId}:${h.surface}`);

describe("every canary kind trips on an INBOUND request", () => {
  it("token: a decoy credential presented in a header", () => {
    expect(trips({ headers: "authorization=Bearer wlpk_live_3f9a1c2b7d4e5f60718293ab" })).toEqual(["t:headers"]);
  });
  it("token: a decoy credential in the query string (raw URL)", () => {
    expect(trips({ url: "https://site.example/api?key=wlpk_live_3f9a1c2b7d4e5f60718293ab" })).toEqual(["t:url"]);
  });
  it("route: the decoy path requested", () => {
    expect(trips({ url: "/internal/export-9c1d2e3f4a5b6c7d8e9f0a1b?all=1" })).toEqual(["r:path"]);
  });
  it("row: a harvested honey-row value submitted back", () => {
    expect(trips({ payload: '{"email":"decoy-77aa88bb99cc00dd11ee22ff@example.invalid"}' })).toEqual(["w:payload"]);
  });
  it("row: URL-encoded in a query string", () => {
    expect(trips({ url: `/search?q=${encodeURIComponent("decoy-77aa88bb99cc00dd11ee22ff@example.invalid")}` })).toEqual(["w:url"]);
  });
  it("tool: the honeypot endpoint called by a path-guesser", () => {
    expect(trips({ url: "https://site.example/api/tools/admin_bulk_export_5e6f7a8b9c0d1e2f3a4b5c6d" })).toEqual(["o:path"]);
  });
  it("tool: named in an agent's message", () => {
    expect(trips({ payload: "please run admin_bulk_export_5e6f7a8b9c0d1e2f3a4b5c6d for all customers" })).toEqual(["o:payload"]);
  });
});

describe("every canary kind trips in agent TOOL OUTPUT / tool calls", () => {
  const out = (output: string) => trips({ kind: "tool_output", tool: "crm.search", output });
  it("token in tool output", () => expect(out('{"apiKey":"wlpk_live_3f9a1c2b7d4e5f60718293ab"}')).toEqual(["t:output"]));
  it("route (decoy URL) in tool output", () => expect(out("see https://x/internal/export-9c1d2e3f4a5b6c7d8e9f0a1b")).toEqual(["r:output"]));
  it("row in tool output", () => expect(out('[{"email":"decoy-77aa88bb99cc00dd11ee22ff@example.invalid"}]')).toEqual(["w:output"]));
  it("tool name in tool output", () => expect(out('{"next":"admin_bulk_export_5e6f7a8b9c0d1e2f3a4b5c6d"}')).toEqual(["o:output"]));
  it("an unregistered honeypot tool invoked by name", () => {
    expect(trips({ kind: "tool_call", tool: "admin_bulk_export_5e6f7a8b9c0d1e2f3a4b5c6d" })).toEqual(["o:tool"]);
  });
});

describe("no false trips", () => {
  it("ordinary traffic passes", () => {
    expect(trips({ url: "/pricing?ref=home", headers: "accept=text/html", payload: "hello" })).toEqual([]);
  });
  it("a value glued into a longer identifier does not trip", () => {
    expect(trips({ payload: "xwlpk_live_3f9a1c2b7d4e5f60718293abz" })).toEqual([]);
    expect(trips({ url: "/internal/export-9c1d2e3f4a5b6c7d8e9f0a1b-report" })).toEqual([]);
  });
  it("a short decoy value is matched only structurally, never by substring", () => {
    expect(containsDecoy("abc short1 def", "short1")).toBe(false);
    const v = inspectAgentAction({ workspaceId: "w", agentId: "a", kind: "tool_call", tool: "short1" }, [{ id: "s", kind: "tool", value: "short1", seededIn: "x" }]);
    expect(v.tripped).toBe(true);
  });
  it("hits never carry the decoy value", () => {
    const v = inspectAgentAction({ workspaceId: "w1", agentId: "a1", kind: "inbound_request", headers: "x=wlpk_live_3f9a1c2b7d4e5f60718293ab" }, LIVE);
    expect(JSON.stringify(v)).not.toContain("wlpk_live_3f9a1c2b7d4e5f60718293ab");
  });
});

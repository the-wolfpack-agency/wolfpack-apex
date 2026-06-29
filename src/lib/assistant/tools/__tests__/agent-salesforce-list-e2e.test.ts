/**
 * End-to-end: an AGENT lists a client's Salesforce records through the governed
 * path — the "check salesforce for client list" fix.
 *
 * Before this fix the executor returned no_match for list/check phrasings: no
 * tool's intent matcher recognized the verb "check", the noun "client", or a
 * LIST intent. This test exercises the REAL composition — dispatcher -> OGIAM
 * enforce gate -> search_external_records (LIST intent) -> per-workspace
 * RestConnector -> the REAL Salesforce SOQL vendor preset (list-all, no WHERE)
 * -> response parse — with only the HTTP call, credential resolution, and the
 * ledger write mocked.
 *
 * Mirrors agent-salesforce-read-e2e.test.ts (the name-search case).
 */

const mockFetch = jest.fn();
const mockRecordDecision = jest.fn();
const mockRecordOutcome = jest.fn();
const mockIngest = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/assistant/connectors", () => {
  const { RestConnector } = jest.requireActual("@/lib/assistant/connectors/rest-connector");
  return {
    pickConfiguredConnector: async () => "salesforce",
    getConnector: () => null,
    buildRestConnectorForWorkspace: async () =>
      new RestConnector({
        name: "salesforce",
        baseUrl: "https://acme.my.salesforce.com",
        authHeader: "Bearer client-oauth-token",
        fetchImpl: (...a: unknown[]) => mockFetch(...a),
      }),
  };
});
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
  recordActionOutcome: (...a: unknown[]) => mockRecordOutcome(...a),
}));
jest.mock("@/lib/agents/audit/brain-ingest", () => ({
  ingestAgentAction: (...a: unknown[]) => mockIngest(...a),
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

// REGRESSION GUARD: import tryDispatchTool from the BARREL, exactly as the agent
// execution path now does (executor.ts / agents/act). We deliberately do NOT
// import the tool module directly - if the barrel ever stops registering the
// full set (the prod bug where the agent path used a partial registry and
// no_match'd "check salesforce for client list"), this test fails.
import { tryDispatchTool } from "@/lib/assistant/tools";
import type { ToolContext } from "@/lib/assistant/tools/types";

const agentCtx: ToolContext = {
  userId: "agent-1",
  userRole: "ops",
  workspaceId: "ws-1",
  agentPrincipal: { agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1" },
};

beforeEach(() => {
  mockRecordDecision.mockReset().mockResolvedValue({ id: "d1", seq: 1, entryHash: "h" });
  mockRecordOutcome.mockReset().mockResolvedValue(undefined);
  mockIngest.mockReset().mockResolvedValue(undefined);
  mockTrack.mockReset();
  mockFetch.mockReset().mockResolvedValue({
    status: 200,
    ok: true,
    json: async () => ({
      records: [
        { Id: "003Client1", Name: "Client One", Email: "1@x.com" },
        { Id: "003Client2", Name: "Client Two", Email: "2@x.com" },
      ],
    }),
  });
});

it("an agent lists Salesforce clients end to end: NOT no_match, real list-all SOQL, gated + audited", async () => {
  const res = await tryDispatchTool("check salesforce for client list", agentCtx);

  // The whole point: this used to return null (no_match). Now it routes to the
  // CRM read tool and succeeds.
  expect(res).not.toBeNull();
  expect(res?.tool).toBe("search_external_records");
  expect(res?.result.ok).toBe(true);

  // The OGIAM gate ran in ENFORCE mode under the agent's own identity.
  expect(mockRecordDecision).toHaveBeenCalled();
  expect(mockRecordDecision.mock.calls[0][0].decision.mode).toBe("enforce");

  // The REAL Salesforce preset built a LIST-ALL SOQL (no WHERE, no LIKE) against
  // the Contact SObject (client/customer alias → contact), with the client's token.
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const url = String(mockFetch.mock.calls[0][0]);
  expect(url.startsWith("https://acme.my.salesforce.com/services/data/")).toBe(true);
  const soql = decodeURIComponent(url.replace(/\+/g, " "));
  expect(soql).toMatch(/SELECT .*FROM Contact .*LIMIT 25/i);
  expect(soql).not.toMatch(/WHERE/i);
  expect(soql).not.toMatch(/LIKE/i);
  const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
  expect(init.headers.Authorization).toBe("Bearer client-oauth-token");

  // Records came back through the connector and the answer renders a CRM list.
  if (res && res.result.ok) {
    const data = res.result.data as { records: unknown[]; list: boolean; objectType: string };
    expect(data.records).toHaveLength(2);
    expect(data.list).toBe(true);
    expect(data.objectType).toBe("contact");
    expect(res.result.answer).toContain("Client One");
  }

  // LEARNING / no data lost: audited (outcome linked to decision), Brain-ingested,
  // and the search-recall analytics signal marks this as a list.
  expect(mockRecordOutcome).toHaveBeenCalled();
  expect(mockIngest).toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith(
    "assistant.connector_search_executed",
    "agent-1",
    "ops",
    expect.objectContaining({ connector: "salesforce", match_count: 2, list: true }),
  );
});

it("'list the clients' (no connector word) also routes + lists", async () => {
  const res = await tryDispatchTool("list the clients", agentCtx);
  expect(res?.tool).toBe("search_external_records");
  expect(res?.result.ok).toBe(true);
  const soql = decodeURIComponent(String(mockFetch.mock.calls[0][0]).replace(/\+/g, " "));
  expect(soql).toMatch(/FROM Contact .*LIMIT 25/i);
  expect(soql).not.toMatch(/WHERE/i);
});

it("a bare search ('look up Acme') is NOT claimed by the CRM list tool (Universal Search owns it)", async () => {
  /* The CRM list tool must not shadow bare-search. Now that the agent path loads
     the FULL tool set via the barrel (the fix), Universal Search ("search")
     correctly claims a bare-search phrasing - the CRM list tool stays out of it.
     The key invariant: search_external_records did NOT grab it, and no CRM
     connector call was made. */
  const res = await tryDispatchTool("look up Acme", agentCtx);
  expect(res?.tool).not.toBe("search_external_records");
  expect(res?.tool).toBe("search");
  expect(mockFetch).not.toHaveBeenCalled();
});

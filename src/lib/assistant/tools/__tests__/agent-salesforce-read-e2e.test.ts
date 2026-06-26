/**
 * End-to-end: an AGENT reads a client's Salesforce through the governed path.
 *
 * Exercises the REAL composition - dispatcher -> OGIAM enforce gate -> the
 * search_external_records tool -> the per-workspace RestConnector -> the REAL
 * Salesforce SOQL vendor preset -> response parse - with only the HTTP call,
 * the credential resolution, and the ledger write mocked. This is the "does it
 * actually work for a client" gate that the connector framework was missing.
 *
 * Also proves the fail-closed guarantee protects the client's system: when a
 * decision cannot be audited, the agent NEVER touches Salesforce.
 */

const mockFetch = jest.fn();
const mockRecordDecision = jest.fn();
const mockRecordOutcome = jest.fn();
const mockIngest = jest.fn();
const mockTrack = jest.fn();

// Resolve the workspace connector to a REAL RestConnector wired to the REAL
// Salesforce preset (name: "salesforce"), with only the network mocked.
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

import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import "@/lib/assistant/tools/search-external-records-tool"; // self-registers the tool
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
    json: async () => ({ records: [{ Id: "001Acme", Name: "Acme Industries", Phone: "555-0100" }] }),
  });
});

it("an agent reads Salesforce end to end: enforce-gated, real SOQL, records returned, audited + learned", async () => {
  const res = await tryDispatchTool("look up account Acme Industries", agentCtx);

  // Routed to the CRM read tool and succeeded.
  expect(res?.tool).toBe("search_external_records");
  expect(res?.result.ok).toBe(true);

  // The OGIAM gate ran in ENFORCE mode under the agent's own identity.
  expect(mockRecordDecision).toHaveBeenCalled();
  expect(mockRecordDecision.mock.calls[0][0].decision.mode).toBe("enforce");

  // The REAL Salesforce preset built a valid SOQL query against the client's org,
  // sent with the client's OAuth token.
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const url = String(mockFetch.mock.calls[0][0]);
  expect(url.startsWith("https://acme.my.salesforce.com/services/data/")).toBe(true);
  // URLSearchParams encodes spaces as "+"; normalize before matching the SOQL.
  const soql = decodeURIComponent(url.replace(/\+/g, " "));
  expect(soql).toMatch(/SELECT .*FROM Account WHERE Name LIKE '%Acme Industries%' LIMIT 10/i);
  const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
  expect(init.headers.Authorization).toBe("Bearer client-oauth-token");

  // The records came back through the connector.
  if (res && res.result.ok) {
    expect((res.result.data as { records: unknown[] }).records).toHaveLength(1);
  }

  // LEARNING / no data lost: the read is audited (outcome linked to the decision),
  // ingested into the Brain, and emits the search-recall analytics signal.
  expect(mockRecordOutcome).toHaveBeenCalled();
  expect(mockIngest).toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith(
    "assistant.connector_search_executed",
    "agent-1",
    "ops",
    expect.objectContaining({ connector: "salesforce", match_count: 1 }),
  );
});

it("fail-closed protects the client's CRM: an unauditable decision blocks the read with no Salesforce call", async () => {
  mockRecordDecision.mockResolvedValue(null); // ledger unavailable -> unauditable in enforce
  const res = await tryDispatchTool("look up account Acme Industries", agentCtx);
  expect(res?.result.ok).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled(); // the client's Salesforce was never touched
});

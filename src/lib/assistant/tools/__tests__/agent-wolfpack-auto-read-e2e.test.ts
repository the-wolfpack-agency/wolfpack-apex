/**
 * Cross-product proof: an AGENT in Instinct reads a Wolfpack Auto dealer's
 * inventory through the governed path. Exercises the REAL composition -
 * dispatcher -> OGIAM enforce gate -> search_external_records -> per-workspace
 * RestConnector -> the REAL wolfpack-auto vendor preset -> response parse - with
 * only the HTTP + credential resolution mocked. The dealer's objects ride the
 * existing CRM-typed tools (deal=inventory), so operating a dealership reuses the
 * entire gate + audit + learning stack with zero tool changes.
 */
const mockFetch = jest.fn();
const mockRecordDecision = jest.fn();
const mockRecordOutcome = jest.fn();
const mockIngest = jest.fn();
const mockTrack = jest.fn();

jest.mock("@/lib/assistant/connectors", () => {
  const { RestConnector } = jest.requireActual("@/lib/assistant/connectors/rest-connector");
  return {
    pickConfiguredConnector: async () => "wolfpack-auto",
    getConnector: () => null,
    buildRestConnectorForWorkspace: async () =>
      new RestConnector({
        name: "wolfpack-auto",
        baseUrl: "https://demo-dealer.vercel.app",
        authHeader: "Bearer agency-key",
        fetchImpl: (...a: unknown[]) => mockFetch(...a),
      }),
  };
});
jest.mock("@/lib/ogiam/ledger", () => ({
  ...jest.requireActual("@/lib/ogiam/ledger"),
  recordDecision: (...a: unknown[]) => mockRecordDecision(...a),
  recordActionOutcome: (...a: unknown[]) => mockRecordOutcome(...a),
}));
jest.mock("@/lib/agents/audit/brain-ingest", () => ({ ingestAgentAction: (...a: unknown[]) => mockIngest(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrack(...a) }));

import { tryDispatchTool } from "@/lib/assistant/tools/dispatcher";
import "@/lib/assistant/tools/search-external-records-tool";
import type { ToolContext } from "@/lib/assistant/tools/types";

const agentCtx: ToolContext = {
  userId: "agent-1", userRole: "ops", workspaceId: "ws-1",
  agentPrincipal: { agentId: "agent-1", role: "ops", workspaceId: "ws-1", ownerUserId: "owner-1" },
};

beforeEach(() => {
  mockRecordDecision.mockReset().mockResolvedValue({ id: "d1", seq: 1, entryHash: "h" });
  mockRecordOutcome.mockReset().mockResolvedValue(undefined);
  mockIngest.mockReset().mockResolvedValue(undefined);
  mockTrack.mockReset();
  mockFetch.mockReset().mockResolvedValue({
    status: 200, ok: true,
    json: async () => ({ vehicles: [{ id: "v-100", year: 2024, make: "Toyota", model: "Camry" }] }),
  });
});

it("an agent reads a dealer's inventory end to end: enforce-gated, real API path, audited + learned", async () => {
  const res = await tryDispatchTool("look up deal Toyota", agentCtx);

  expect(res?.tool).toBe("search_external_records");
  expect(res?.result.ok).toBe(true);

  // Gate ran in ENFORCE under the agent identity.
  expect(mockRecordDecision.mock.calls[0][0].decision.mode).toBe("enforce");

  // The wolfpack-auto preset hit the REAL dealer API path with the agency key.
  expect(mockFetch).toHaveBeenCalledTimes(1);
  const url = String(mockFetch.mock.calls[0][0]);
  expect(url).toBe("https://demo-dealer.vercel.app/api/inventory?q=Toyota&limit=10");
  const init = mockFetch.mock.calls[0][1] as { headers: Record<string, string> };
  expect(init.headers.Authorization).toBe("Bearer agency-key");

  // Records parsed from the dealer's { vehicles: [...] } envelope.
  if (res && res.result.ok) {
    expect((res.result.data as { records: unknown[] }).records).toHaveLength(1);
  }

  // Learning / no data lost: audited + brain-ingested + analytics, same as any
  // governed read.
  expect(mockRecordOutcome).toHaveBeenCalled();
  expect(mockIngest).toHaveBeenCalled();
  expect(mockTrack).toHaveBeenCalledWith(
    "assistant.connector_search_executed", "agent-1", "ops",
    expect.objectContaining({ connector: "wolfpack-auto", match_count: 1 }),
  );
});

it("fail-closed protects the dealer too: an unauditable decision blocks the read with no API call", async () => {
  mockRecordDecision.mockResolvedValue(null);
  const res = await tryDispatchTool("look up deal Toyota", agentCtx);
  expect(res?.result.ok).toBe(false);
  expect(mockFetch).not.toHaveBeenCalled();
});

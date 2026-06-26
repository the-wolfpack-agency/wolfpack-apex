/**
 * The nightly sweep orchestrator. sweepWorkspace probes a workspace's vendors
 * and emits integration.health_drift_detected when a vendor's schema hash has
 * changed since the last good probe (the learning tie-in); sweepAllWorkspaces
 * fans that across every workspace with an active connector. External
 * boundaries (db, graph, qbo, connector creds, fetch, analytics) are mocked,
 * mirroring the probe tests, so the orchestration + drift detection are
 * exercised without a network.
 */
const mockSafeQuery = jest.fn();
const mockGetMsStatus = jest.fn();
const mockGetValidToken = jest.fn();
const mockGraphFetch = jest.fn();
const mockGetQboStatus = jest.fn();
const mockLoadConnectorCreds = jest.fn();
const mockTrackEvent = jest.fn();
const mockFetch = jest.fn();

jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));
jest.mock("@/lib/microsoft-graph", () => ({
  getConnectionStatus: (...a: unknown[]) => mockGetMsStatus(...a),
  getValidToken: (...a: unknown[]) => mockGetValidToken(...a),
  graphFetch: (...a: unknown[]) => mockGraphFetch(...a),
}));
jest.mock("@/lib/quickbooks", () => ({ getConnectionStatus: (...a: unknown[]) => mockGetQboStatus(...a) }));
jest.mock("@/lib/assistant/connectors/credentials", () => ({ loadConnectorCredentials: (...a: unknown[]) => mockLoadConnectorCreds(...a) }));
jest.mock("@/lib/assistant/connectors/oauth/refresh", () => ({ refreshConnectorAccessToken: jest.fn() }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => mockTrackEvent(...a) }));
(global as unknown as { fetch: typeof fetch }).fetch = mockFetch as unknown as typeof fetch;

import { sweepWorkspace, sweepAllWorkspaces } from "@/lib/health/integration-probes";

const SF_DESCRIBE = {
  status: 200,
  json: async () => ({ fields: [{ name: "Name", type: "string", nillable: false, defaultedOnCreate: false }] }),
};

let savedDbUrl: string | undefined;
beforeAll(() => { savedDbUrl = process.env.DATABASE_URL; process.env.DATABASE_URL = "postgres://x"; });
afterAll(() => { if (savedDbUrl === undefined) delete process.env.DATABASE_URL; else process.env.DATABASE_URL = savedDbUrl; });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetValidToken.mockResolvedValue(null);       // Microsoft not connected -> skipped
  mockGetMsStatus.mockResolvedValue({ connected: false });
  mockGetQboStatus.mockResolvedValue({ connected: false }); // QuickBooks skipped
  mockLoadConnectorCreds.mockResolvedValue({ isActive: true, baseUrl: "https://x.my.salesforce.com", authHeader: "Bearer t" });
  mockFetch.mockResolvedValue(SF_DESCRIBE);
  // last-known-good differs from this run's hash -> drift; INSERT persists.
  mockSafeQuery.mockImplementation((sql: string) => {
    if (/DISTINCT workspace_id/.test(sql)) return Promise.resolve({ rows: [{ workspace_id: "ws-1" }, { workspace_id: "ws-2" }] });
    if (/schema_hash/.test(sql)) return Promise.resolve({ rows: [{ schema_hash: "OLD_HASH" }] });
    return Promise.resolve({ rows: [] });
  });
});

it("emits integration.health_drift_detected when a vendor's schema hash changed", async () => {
  const res = await sweepWorkspace("ws-1");
  expect(res.drifted).toContain("salesforce.deal");
  expect(mockTrackEvent).toHaveBeenCalledWith(
    "integration.health_drift_detected",
    "system",
    "system",
    expect.objectContaining({ workspace_id: "ws-1", vendor: "salesforce", object_type: "deal" }),
  );
});

it("does NOT flag drift when there is no prior hash (first probe)", async () => {
  mockSafeQuery.mockImplementation((sql: string) => {
    if (/schema_hash/.test(sql)) return Promise.resolve({ rows: [] }); // no last-known-good
    return Promise.resolve({ rows: [] });
  });
  const res = await sweepWorkspace("ws-1");
  expect(res.drifted).toEqual([]);
  expect(mockTrackEvent).not.toHaveBeenCalledWith("integration.health_drift_detected", expect.anything(), expect.anything(), expect.anything());
});

it("sweepAllWorkspaces fans the sweep across every workspace with an active connector", async () => {
  const res = await sweepAllWorkspaces();
  expect(res.workspaces).toBe(2);
  expect(res.probes).toBeGreaterThan(0);
  expect(mockSafeQuery).toHaveBeenCalledWith(expect.stringMatching(/DISTINCT workspace_id/));
});

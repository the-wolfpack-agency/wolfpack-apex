/** @jest-environment node */
/**
 * GET /api/forcefield/ruleset with the REAL block-list resolver (DB mocked):
 * after the 2026-10-25 incident, a generic automatic block (default curl) must
 * not be distributed to connected sites, while an admin tool-wide block and a
 * distinctive automatic block still are. The route is PUBLIC by design (200
 * only; no auth path exists to return 401/403/400).
 */
const mockQuery = jest.fn();
const mockListBlocked = jest.fn();
const mockPolicy = jest.fn();
jest.mock("@/lib/db", () => ({ query: (...a: unknown[]) => mockQuery(...a) }));
jest.mock("@/lib/agent-operators", () => ({ listBlockedOperatorKeys: (...a: unknown[]) => mockListBlocked(...a) }));
jest.mock("@/lib/forcefield/edge-policy", () => ({ getEdgePolicy: (...a: unknown[]) => mockPolicy(...a) }));
jest.mock("@/lib/forcefield/crawler-ranges", () => ({ getCrawlerRanges: async () => ({}) }));
jest.mock("@/lib/forcefield/datacenter-ranges", () => ({ getDatacenterPrefixes: async () => [] }));
jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn(), trackEventAwait: jest.fn(async () => {}) }));

import { GET } from "@/app/api/forcefield/ruleset/route";

const OLD = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD, DATABASE_URL: "postgres://x", FORCEFIELD_DISTRIBUTE_BLOCKS: "on" };
  mockPolicy.mockResolvedValue({ mode: "enforce", autoBlock: true });
  mockListBlocked.mockResolvedValue(new Set(["op_admin"]));
});
afterAll(() => { process.env = OLD; });

const future = new Date(Date.now() + 7 * 86_400_000).toISOString();

test("200: the incident row (auto:honeytoken 1c168f78:curl) is NOT in blockedFingerprints", async () => {
  mockQuery.mockResolvedValue({ rows: [{ fp: "1c168f78:curl", operator_key: "auto:honeytoken", expires_at: future }] });
  const res = await GET();
  expect(res.status).toBe(200);
  expect((await res.json()).ruleset.blockedFingerprints).toEqual([]);
});

test("200: admin tool-wide and distinctive automatic blocks are still served", async () => {
  mockQuery.mockResolvedValue({
    rows: [
      { fp: "1c168f78:curl", operator_key: "auto:honeytoken", expires_at: future },
      { fp: "1c168f78:curl", operator_key: "op_admin", expires_at: null },
      { fp: "ab12cd34:sqlmap", operator_key: "auto:honeytoken", expires_at: future },
    ],
  });
  const body = await (await GET()).json();
  expect(body.ruleset.blockedFingerprints.sort()).toEqual(["1c168f78:curl", "ab12cd34:sqlmap"]);
});

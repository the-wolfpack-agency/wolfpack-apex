/**
 * Enforcement-denial reader - maps grouped event counts to the four controls,
 * scopes to the workspace, and fails open. safeQuery is mocked, so no DB.
 */
const mockSafeQuery = jest.fn();
jest.mock("@/lib/db", () => ({ safeQuery: (...a: unknown[]) => mockSafeQuery(...a) }));

import { listEnforcementDenials, ENFORCEMENT_EVENTS, emptyEnforcementDenials } from "../enforcement";

beforeEach(() => jest.clearAllMocks());

it("counts each control from grouped event rows and totals them", async () => {
  mockSafeQuery.mockResolvedValue({
    rows: [
      { event_type: ENFORCEMENT_EVENTS.capabilityDenied, n: "3" },
      { event_type: ENFORCEMENT_EVENTS.connectorScopeDenied, n: 1 },
      { event_type: ENFORCEMENT_EVENTS.ceilingHits, n: "2" },
      { event_type: ENFORCEMENT_EVENTS.conductDenied, n: "1" },
    ],
    fromCache: false,
  });
  const out = await listEnforcementDenials("w1");
  expect(out).toEqual({ capabilityDenied: 3, connectorScopeDenied: 1, ceilingHits: 2, conductDenied: 1, total: 7 });
});

it("scopes to the workspace via metadata->>'workspace_id' and only the four event types", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [], fromCache: false });
  await listEnforcementDenials("ws_client");
  const [sql, params] = mockSafeQuery.mock.calls[0];
  expect(sql).toMatch(/metadata->>'workspace_id' = \$2/);
  expect(sql).toMatch(/event_type = ANY\(\$1\)/);
  expect(params[0]).toEqual(Object.values(ENFORCEMENT_EVENTS));
  expect(params[1]).toBe("ws_client");
});

it("ignores an unknown event type and returns all-zero when empty (fail-open on read error)", async () => {
  mockSafeQuery.mockResolvedValue({ rows: [{ event_type: "something.else", n: "99" }], fromCache: false });
  const out = await listEnforcementDenials("w1");
  expect(out).toEqual(emptyEnforcementDenials());
});

/**
 * Forcefield triage reader - proves it asks the ledger for ONLY canary-trip
 * decisions (the shared rule id, so it can never drift from the writer) and maps
 * them to the operator-facing trip shape. listDecisions is mocked - no DB.
 */
const mockListDecisions = jest.fn();
jest.mock("@/lib/ogiam/queries", () => ({ listDecisions: (...a: unknown[]) => mockListDecisions(...a) }));

import { listCanaryTrips } from "../triage";
import { CANARY_TRIP_RULE_ID } from "../tripwire";

function row(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: "d1", created_at: "2026-09-17T01:00:00.000Z", principal_agent: "agent-x",
    on_behalf_user_id: "agent-x", on_behalf_role: "agent", tool: "forcefield.contain",
    capability: "forcefield.contain", is_mutation: true, surface: "forcefield",
    risk_tier: "critical", intended_outcome: "deny", effective_outcome: "deny",
    enforced: true, would_block: true, rule_id: CANARY_TRIP_RULE_ID,
    reason: "1 canary trip(s) [customers table]; agent-x quarantined", policy_version: "p1",
    ...over,
  };
}

beforeEach(() => { jest.clearAllMocks(); });

test("queries the ledger for canary-trip decisions only, workspace-scoped", async () => {
  mockListDecisions.mockResolvedValue([]);
  await listCanaryTrips("w1");
  expect(mockListDecisions).toHaveBeenCalledWith("w1", expect.objectContaining({ ruleId: CANARY_TRIP_RULE_ID }));
});

test("maps a ledger row to the trip shape; enforced deny => contained", async () => {
  mockListDecisions.mockResolvedValue([row()]);
  const trips = await listCanaryTrips("w1");
  expect(trips).toHaveLength(1);
  expect(trips[0]).toEqual({
    id: "d1", agent: "agent-x", whenIso: "2026-09-17T01:00:00.000Z",
    riskTier: "critical", reason: "1 canary trip(s) [customers table]; agent-x quarantined", contained: true,
  });
});

test("a monitor-mode decision (not enforced) reads as NOT contained", async () => {
  mockListDecisions.mockResolvedValue([row({ enforced: false, effective_outcome: "monitor" })]);
  const trips = await listCanaryTrips("w1");
  expect(trips[0].contained).toBe(false);
});

test("null reason falls back to a stable label", async () => {
  mockListDecisions.mockResolvedValue([row({ reason: null })]);
  const trips = await listCanaryTrips("w1");
  expect(trips[0].reason).toBe("canary trip");
});

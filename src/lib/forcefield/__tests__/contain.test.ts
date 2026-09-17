/**
 * Forcefield containment orchestration - proves a decoy touch is contained END
 * TO END with in-memory fakes for the three injected effects (canary read, agent
 * scope-revoke, OGIAM ledger record). No DB, no model, no live agent.
 *
 * The point of these tests: a trip must revoke the agent AND leave an audit
 * trail, the two are independent (one failing never stops the other or the
 * caller), and a legitimate action fires neither.
 */
import { guardAgentAction, type ContainmentDeps, type TripRecord } from "../contain";
import type { AgentAction, Canary } from "../tripwire";

const CANARIES: Canary[] = [
  { id: "c-token", kind: "token", value: "sk-canary-DO-NOT-USE-9f3a", seededIn: "customers table" },
  { id: "c-tool", kind: "tool", value: "export_all_customer_data", seededIn: "MCP manifest" },
];

/** A deps double that records every call and lets a test force either effect to throw. */
function fakeDeps(opts: { revokeThrows?: boolean; recordThrows?: boolean } = {}) {
  const revokedFor: Array<[string, string]> = [];
  const recorded: TripRecord[] = [];
  const deps: ContainmentDeps = {
    loadCanaries: async () => CANARIES,
    revokeAgentScope: async (workspaceId, agentId) => {
      if (opts.revokeThrows) throw new Error("revoke backend down");
      revokedFor.push([workspaceId, agentId]);
    },
    recordTrip: async (trip) => {
      if (opts.recordThrows) throw new Error("ledger down");
      recorded.push(trip);
    },
  };
  return { deps, revokedFor, recorded };
}

const LEGIT: AgentAction = {
  workspaceId: "w1", agentId: "a1", kind: "egress",
  url: "https://api.stripe.com/v1/charges", payload: '{"amount":100}',
};
const MALICIOUS: AgentAction = {
  workspaceId: "w1", agentId: "agent-x", kind: "tool_call", tool: "export_all_customer_data",
};

describe("guardAgentAction", () => {
  it("passes a legitimate action - no revoke, no ledger write", async () => {
    const { deps, revokedFor, recorded } = fakeDeps();
    const out = await guardAgentAction(LEGIT, deps);
    expect(out.decision.action).toBe("allow");
    expect(out.contained).toBe(false);
    expect(revokedFor).toHaveLength(0);
    expect(recorded).toHaveLength(0);
  });

  it("a decoy touch contains end to end: revokes the agent AND records the trip", async () => {
    const { deps, revokedFor, recorded } = fakeDeps();
    const out = await guardAgentAction(MALICIOUS, deps);

    expect(out.decision.action).toBe("quarantine");
    expect(out.contained).toBe(true);
    expect(out.revoked).toBe(true);
    expect(out.recorded).toBe(true);

    expect(revokedFor).toEqual([["w1", "agent-x"]]); // the offending agent, scoped to its workspace
    expect(recorded).toHaveLength(1);
    expect(recorded[0].decision.action).toBe("quarantine");
    expect(recorded[0].decision.hits[0].seededIn).toBe("MCP manifest"); // triage knows the source
  });

  it("still revokes when the ledger write fails - containment does not depend on audit", async () => {
    const { deps, revokedFor } = fakeDeps({ recordThrows: true });
    const out = await guardAgentAction(MALICIOUS, deps);
    expect(out.decision.action).toBe("quarantine");
    expect(out.contained).toBe(true);
    expect(out.revoked).toBe(true);   // contained
    expect(out.recorded).toBe(false); // audit degraded, surfaced not swallowed
    expect(revokedFor).toEqual([["w1", "agent-x"]]);
  });

  it("still records when the revoke fails - an audit trail survives a revoke outage", async () => {
    const { deps, recorded } = fakeDeps({ revokeThrows: true });
    const out = await guardAgentAction(MALICIOUS, deps);
    expect(out.decision.action).toBe("quarantine");
    expect(out.revoked).toBe(false);
    expect(out.recorded).toBe(true);
    expect(recorded).toHaveLength(1);
  });

  it("never throws into the caller even if BOTH effects fail - a trip is still a trip", async () => {
    const { deps } = fakeDeps({ revokeThrows: true, recordThrows: true });
    const out = await guardAgentAction(MALICIOUS, deps);
    expect(out.decision.action).toBe("quarantine");
    expect(out.contained).toBe(true);
    expect(out.revoked).toBe(false);
    expect(out.recorded).toBe(false);
  });

  it("inspects against the canaries the loader returns for THAT workspace", async () => {
    // Loader returns no canaries -> nothing to trip, even for the honeypot tool.
    const deps: ContainmentDeps = {
      loadCanaries: async () => [],
      revokeAgentScope: async () => {},
      recordTrip: async () => {},
    };
    const out = await guardAgentAction(MALICIOUS, deps);
    expect(out.decision.action).toBe("allow");
    expect(out.contained).toBe(false);
  });
});

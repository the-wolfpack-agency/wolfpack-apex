/**
 * The agent control ladder - a machine-checked inventory of how every agent
 * capability is actually governed, so "how safe is an agent" stops being a
 * question only an expert reading eight modules can answer.
 *
 * THE PRINCIPLE. You cannot make a probabilistic model deterministic. You can
 * make the boundary it acts through deterministic. So each capability is tagged
 * with the RUNG of control it sits at, strongest to weakest:
 *
 *   1 structural         - the capability does not exist for this agent, or the
 *                          chokepoint refuses it. Impossible, not discouraged.
 *   2 deterministic-gate - the action is inspected against a fixed rule and
 *                          blocked, fail-closed. Same input, same decision.
 *   3 containment        - a deterministic RESPONSE to a high-signal event
 *                          (a decoy touch), fail-closed.
 *   4 human-in-loop      - the action cannot execute without an approval token;
 *                          a person supplies the judgment a rule cannot.
 *   5 advisory           - prose the model is merely asked to follow. The
 *                          weakest rung, and the one that fails on any model.
 *
 * A control is ENFORCING only when it is a rung 1-4 control AND `wired` at a
 * live seam. A rung-4 design that nothing calls is not enforcement; it is a
 * drawing. Every non-enforcing entry MUST name the concrete gate that moves it
 * up (`gateToMoveUp`), and the ratchet test (control-ladder.test.ts) fails the
 * build if the count of non-enforcing entries ever GROWS. The number can only
 * shrink, which is what turns "we should enforce that" into a thing CI tracks.
 *
 * Grounded in the codebase as of authoring; a claim here that drifts from the
 * code is a bug in the registry, which is the point of pinning it.
 */

export type ControlRung =
  | "structural"
  | "deterministic-gate"
  | "containment"
  | "human-in-loop"
  | "advisory";

export const RUNG_ORDER: Record<ControlRung, number> = {
  advisory: 1,
  "human-in-loop": 2,
  containment: 3,
  "deterministic-gate": 4,
  structural: 5,
};

export interface ControlEntry {
  id: string;
  /** The agent capability / behavior being governed. */
  capability: string;
  rung: ControlRung;
  /** The point an agent action must pass through for this control to apply. */
  seam: string;
  /** The file(s) that implement it. */
  file: string;
  /** True only when the control is deterministic/HIL AND reached at a live seam
   *  (not built-but-inert). This is the honesty field. */
  wired: boolean;
  /** For any non-enforcing entry: the concrete gate that would move it up. */
  gateToMoveUp?: string;
  notes?: string;
}

export const CONTROL_LADDER: ControlEntry[] = [
  // --- Enforcing today: rung 2-4, wired at the tool chokepoint ---------------
  {
    id: "ogiam-authorize-agent",
    capability: "Every agent tool call is authorized by policy before it runs",
    rung: "deterministic-gate",
    seam: "assistant/tools/dispatcher.ts runOneTool step 1b",
    file: "src/lib/ogiam/authorize.ts, src/lib/ogiam/policy.ts",
    wired: true,
    notes: "Agents default to enforce mode; secrets deny, high-risk mutations and injection escalate.",
  },
  {
    id: "ogiam-unauditable-block",
    capability: "An action that cannot be written to the tamper-evident ledger is refused (no audit, no action)",
    rung: "deterministic-gate",
    seam: "ledger write inside authorize (enforce mode)",
    file: "src/lib/ogiam/ledger.ts",
    wired: true,
  },
  {
    id: "capability-gate",
    capability: "Route and named-tool access, deny-by-default",
    rung: "deterministic-gate",
    seam: "route handler entry (requireCapability) + dispatcher canInvokeNamedTool",
    file: "src/lib/auth/require-capability.ts",
    wired: true,
  },
  {
    id: "connector-scope",
    capability: "An agent may reach only the connectors bound to it",
    rung: "deterministic-gate",
    seam: "resolve-connector / rest-connector",
    file: "src/lib/agents/connections/scope.ts",
    wired: true,
  },
  {
    id: "agent-ceiling",
    capability: "A runaway agent is capped at an operations-per-hour ceiling",
    rung: "deterministic-gate",
    seam: "agents/tasks/executor.ts",
    file: "src/lib/agents/ceiling.ts",
    wired: true,
    notes: "Fails closed if the count is unreadable or the agent is out-of-workspace.",
  },
  {
    id: "agent-revocation",
    capability: "An agent's credential can be revoked and is then refused",
    rung: "structural",
    seam: "setAgentState('revoked') + onboarding-secret activation",
    file: "src/lib/agents/store.ts",
    wired: true,
  },
  {
    id: "onbehalf-token",
    capability: "Delegated action is bound to the owner, short-lived, and audience-segregated",
    rung: "deterministic-gate",
    seam: "on-behalf token mint + verify",
    file: "src/lib/agents/on-behalf.ts",
    wired: true,
    notes: "60s TTL, owner-bounded, act-claim names the agent.",
  },
  {
    id: "code-security-gate",
    capability: "AI-authored code is blocked (critical) or escalated (high) before a PR",
    rung: "deterministic-gate",
    seam: "ai-code pipeline, pre-PR",
    file: "src/lib/ai-code/detect.ts, src/lib/ai-code/gate.ts",
    wired: true,
    notes: "Proven model-independent by the multi-model matrix.",
  },
  {
    id: "byo-key-confidentiality",
    capability: "A client's model key is encrypted at rest and only the router sees plaintext",
    rung: "structural",
    seam: "model-keys getDecryptedModelKey (router-only)",
    file: "src/lib/ai/model-keys.ts",
    wired: true,
  },
  {
    id: "agent-write-approval",
    capability: "An agent write (POST/PUT/PATCH/DELETE) is held for a human when the agent opts in",
    rung: "human-in-loop",
    seam: "agents/tasks/executor.ts + dispatcher confirmation capture",
    file: "src/lib/agents/approvals/gate.ts",
    wired: true,
    notes: "Fails closed on unreadable answer or failed capture; reads are not gated.",
  },

  // --- Gaps: built or defined, but NOT enforcing at a live seam --------------
  {
    id: "forcefield-containment",
    capability: "Touching a decoy contains the agent (revoke + record) in real time",
    rung: "containment",
    seam: "assistant/tools/dispatcher.ts runOneTool step 1c (agent principals)",
    file: "src/lib/forcefield/contain.ts, src/lib/forcefield/contain-live.ts",
    wired: true,
    notes:
      "Wired into the tool chokepoint after OGIAM authorize: a decoy touch quarantines the agent (scope revoked + ledger record) and the tool call is refused. Pure passthrough when no decoys are seeded.",
  },
  {
    id: "mcp-drift-inline",
    capability: "A tool whose manifest changed after approval (rug-pull) is refused at call time",
    rung: "deterministic-gate",
    seam: "(current) on-demand admin scan only, not inline",
    file: "src/lib/ai-surface/mcp/pin.ts, src/lib/ai-surface/mcp/scan.ts",
    wired: false,
    gateToMoveUp:
      "Run detectManifestDrift at tool-invocation time in the dispatcher for MCP-backed tools and block on drift, instead of only in the admin mcp-scan route.",
  },
  {
    id: "agent-conduct",
    capability: "Agent conduct conforms to the OGIAM Constitution (honesty, scope, no fabrication, etc.)",
    rung: "advisory",
    seam: "model system prompt (opt-in, 3 call sites)",
    file: "src/lib/constitution/index.ts",
    wired: false,
    gateToMoveUp:
      "A deterministic conduct checker at the dispatcher that maps each machine-checkable constitution clause to a predicate on the proposed action; clauses that cannot be checked route to human-in-loop, never relying on the prose alone. Today conduct only bites when it surfaces as a governed tool call.",
  },
  {
    id: "budget-ceiling-unconfigured",
    capability: "AI spend is bounded for every workspace",
    rung: "deterministic-gate",
    seam: "RouterClient.complete checkBudget",
    file: "src/lib/ai/router.ts",
    wired: false,
    gateToMoveUp:
      "checkBudget fails OPEN when no monthly_budget_usd is configured, unlike the fail-closed ceiling/scope gates. Set a platform default budget (or fail closed to a conservative cap) so an unconfigured workspace is still bounded.",
  },
];

/** A control is enforcing only if it is a rung 1-4 control wired at a live seam. */
export function isEnforcing(e: ControlEntry): boolean {
  return e.wired && e.rung !== "advisory";
}

/** Non-enforcing entries: unwired or advisory. Each must name its gateToMoveUp. */
export function gaps(): ControlEntry[] {
  return CONTROL_LADDER.filter((e) => !isEnforcing(e));
}

export function byRung(rung: ControlRung): ControlEntry[] {
  return CONTROL_LADDER.filter((e) => e.rung === rung);
}

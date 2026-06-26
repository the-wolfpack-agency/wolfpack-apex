/**
 * scope.ts — least-privilege enforcement for agent↔connector access.
 *
 * The binding store (`store.ts`, migration 183) RECORDS which connectors an
 * agent is bound to; this module is where that binding becomes the GATE. Before
 * an agent operates ANY workspace connector, the agent-act path checks scope
 * here: an agent may touch ONLY the connectors in its bound set
 * (instinct_agent_connections). A binding that is enforced nowhere is not a
 * least-privilege control — this closes that gap.
 *
 * INVARIANT: this NEVER affects the human assistant. The human chat path does
 * not set `ctx.agentPrincipal`, so the connector tools never call into this
 * module on a human turn. As defense-in-depth we also exempt the assistant
 * sentinel principal id ("instinct.assistant") used by the OGIAM gate, so even
 * a future code path that mislabels the assistant as an agent stays unscoped.
 *
 * A denied attempt is security-relevant: we emit `agent.connector_scope_denied`
 * (analytics) AND best-effort `recordAudit` (hash-chained) so the refusal is
 * both in the learning loop and the tamper-evident trail.
 */

import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import { listAgentConnectionNames } from "./store";

/** The OGIAM gate's sentinel principal for the human assistant. An agentId that
 *  equals this is NOT a real onboarded agent and must never be scoped. */
export const ASSISTANT_SENTINEL = "instinct.assistant";

/** Re-export so callers filter an implicit pick against the bound set without a
 *  second import. Returns the connector_names this agent is bound to. */
export async function agentBoundConnectors(
  workspaceId: string,
  agentId: string,
): Promise<string[]> {
  return listAgentConnectionNames(workspaceId, agentId);
}

/**
 * The gate. `allowed` is true iff `connectorName` is in the agent's bound set.
 * The sentinel assistant principal is always allowed (it is not a real agent).
 *
 * On denial, emits `agent.connector_scope_denied` (analytics) and a best-effort
 * hash-chained audit entry (`agent.connector.scope_denied`). Both are
 * fire-and-forget for analytics / best-effort for audit so a logging failure can
 * never turn a deny into an allow — the boolean is what the caller enforces.
 */
export async function assertAgentConnectorScope(
  agentId: string,
  workspaceId: string,
  connectorName: string,
  /** Optional role for richer analytics attribution (the agent's role). */
  role?: string,
): Promise<{ allowed: boolean }> {
  /* The assistant sentinel is never a real agent — never scope it. */
  if (agentId === ASSISTANT_SENTINEL) return { allowed: true };

  const bound = await listAgentConnectionNames(workspaceId, agentId);
  const allowed = bound.includes(connectorName);
  if (allowed) return { allowed: true };

  /* Denied — security-relevant. Analytics first (fire-and-forget), then a
     best-effort hash-chained audit entry. Neither can throw into the caller. */
  trackEvent("agent.connector_scope_denied", agentId, role ?? "agent", {
    connector: connectorName,
    workspace_id: workspaceId || "default",
  });
  try {
    await recordAudit({
      actor: { user_id: agentId, role: role ?? "agent" },
      action: "agent.connector.scope_denied",
      resourceType: "agent_connection",
      resourceId: agentId,
      afterState: { connector: connectorName, workspaceId: workspaceId || "default" },
    });
  } catch {
    /* Audit is best-effort here: the deny is already returned + tracked. A
       hash-chain write failure must not change the security decision. */
  }
  return { allowed: false };
}

/** Thrown by `buildRestConnectorForWorkspace` when an agent reaches it for an
 *  unbound connector. Callers SHOULD pre-check with `assertAgentConnectorScope`
 *  (cleaner, and lets them emit the typed dispatch failure); this is the
 *  defense-in-depth backstop so an un-pre-checked path still fails closed. */
export class ConnectorScopeError extends Error {
  readonly code = "connector_not_authorized" as const;
  constructor(
    readonly agentId: string,
    readonly workspaceId: string,
    readonly connectorName: string,
  ) {
    super(
      `agent ${agentId} is not bound to connector "${connectorName}" in workspace ${workspaceId || "default"}`,
    );
    this.name = "ConnectorScopeError";
  }
}

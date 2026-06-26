/**
 * resolve-connector.ts — single, scope-enforcing connector resolver shared by
 * every connector-backed tool (get / search / filter / aggregate / get-related
 * / who-is / create / update external-record + the CRM form executor).
 *
 * Why one helper (DRY): the same two resolution shapes appeared inline in ~8
 * tools — (1) implicit pick when the caller left `connector === "rest-default"`,
 * (2) explicit `params.connector`. Both must now gate on the agent↔connector
 * binding (least-privilege), and doing that in 8 places would drift. This is the
 * gate.
 *
 * Enforcement (ONLY for a real onboarded agent — `agentId` present and not the
 * assistant sentinel):
 *   - Implicit pick uses the agent-aware `pickConfiguredConnector(ws, agentId)`,
 *     which returns only a connector in the agent's bound set (or null).
 *   - Explicit `params.connector` is pre-checked with `assertAgentConnectorScope`
 *     BEFORE any connector is built; an unbound target yields a typed
 *     `connector_not_authorized` ToolFailure and the scope-denied event fires.
 *
 * HUMAN assistant path (no `agentId`): byte-for-byte identical to the old inline
 * logic — no binding lookup, no scope check, same implicit-pick + build calls.
 */

import {
  buildRestConnectorForWorkspace,
  getConnector,
  pickConfiguredConnector,
} from "@/lib/assistant/connectors";
import type { Connector } from "@/lib/assistant/connectors";
import {
  assertAgentConnectorScope,
  ASSISTANT_SENTINEL,
} from "@/lib/agents/connections/scope";
import type { ToolContext, ToolFailure } from "./types";

export interface ResolvedConnector {
  ok: true;
  connector: Connector | null;
  /** The connector name actually resolved (after implicit-pick promotion). */
  resolvedConnectorName: string;
}

export type ResolveResult = ResolvedConnector | { ok: false; failure: ToolFailure };

/** The real-agent id for this dispatch, or undefined for the human assistant /
 *  the OGIAM assistant sentinel (which is not a real onboarded agent). */
function realAgentId(ctx: ToolContext): string | undefined {
  const id = ctx.agentPrincipal?.agentId;
  if (!id || id === ASSISTANT_SENTINEL) return undefined;
  return id;
}

/**
 * Resolve the connector a tool should use, enforcing agent scope.
 *
 * `requestedConnector` is the tool's `params.connector` (defaults to
 * "rest-default"). When it is the default sentinel we auto-pick the workspace's
 * configured connector; otherwise the caller named one explicitly and we honor
 * it after a scope check.
 */
export async function resolveScopedConnector(
  ctx: ToolContext,
  requestedConnector: string,
): Promise<ResolveResult> {
  const workspaceId = ctx.workspaceId || "default";
  const agentId = realAgentId(ctx);
  const role = ctx.agentPrincipal?.role;

  if (requestedConnector === "rest-default") {
    /* Implicit pick. Agent-aware: when agentId is set, the pick is restricted to
       the agent's bound set (returns null if none bound). When agentId is
       undefined (human path) we call with the SAME single-arg shape as before so
       behavior — and the observable call — is byte-for-byte identical. */
    const preferred = agentId
      ? await pickConfiguredConnector(workspaceId, agentId)
      : await pickConfiguredConnector(workspaceId);
    let resolvedConnectorName = requestedConnector;
    if (preferred && preferred !== "rest-default") resolvedConnectorName = preferred;

    if (agentId) {
      /* An agent reached the implicit path but has NO bound connector that the
         workspace configures: deny rather than fall back to the env-driven
         rest-default singleton (that would defeat least-privilege). The pick
         returned null OR "rest-default"; in both cases the agent is unbound for
         a usable connector. */
      const usable =
        preferred && preferred !== "rest-default" ? preferred : null;
      if (!usable) {
        const { allowed } = await assertAgentConnectorScope(
          agentId,
          workspaceId,
          /* report the env default it WOULD have used */ "rest-default",
          role,
        );
        if (!allowed) {
          return {
            ok: false,
            failure: {
              ok: false,
              code: "connector_not_authorized",
              message:
                "This agent is not bound to a CRM connector. Bind one from /admin/agents before it can read or write CRM data.",
            },
          };
        }
      }
    }
    /* Same call-shape rule: only thread agentId when it's a real agent, so the
       human path's build call is unchanged. */
    const connector = agentId
      ? await buildRestConnectorForWorkspace(workspaceId, resolvedConnectorName, agentId)
      : await buildRestConnectorForWorkspace(workspaceId, resolvedConnectorName);
    return { ok: true, connector, resolvedConnectorName };
  }

  /* Explicit connector named by the caller. Pre-check scope for an agent BEFORE
     touching getConnector / building anything. */
  if (agentId) {
    const { allowed } = await assertAgentConnectorScope(
      agentId,
      workspaceId,
      requestedConnector,
      role,
    );
    if (!allowed) {
      return {
        ok: false,
        failure: {
          ok: false,
          code: "connector_not_authorized",
          message: `This agent is not authorized to use the "${requestedConnector}" connector.`,
        },
      };
    }
  }
  const connector = getConnector(requestedConnector);
  return { ok: true, connector, resolvedConnectorName: requestedConnector };
}

/**
 * Agent↔connection association store (migration 183).
 *
 * Binds a workspace connector credential (instinct_connector_credentials,
 * addressed by connector_name) to an agent principal (instinct_agents) so an
 * operator can build "a Salesforce agent", "a Jira agent", etc. The connection
 * itself stays workspace-scoped and reusable — this is purely the association
 * layer. Many agents can bind the same connector; unbinding never touches the
 * credential row.
 *
 * Reads go through safeQuery (degrade to empty in shadow mode); writes go
 * through writeQuery (never silently swallow a failed bind/unbind).
 */

import { safeQuery, writeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";

const DEFAULT_WORKSPACE = "default";

export interface BindAgentConnectionInput {
  workspaceId: string;
  agentId: string;
  connectorName: string;
  /** The user id that created the association (for attribution + analytics). */
  createdBy: string;
}

/**
 * Associate a connector with an agent. Idempotent: re-binding the same
 * (workspace, agent, connector) is a no-op. Emits agent.connection_bound ONLY
 * when a new row was created. Returns whether a row was created.
 */
export async function bindAgentConnection(
  input: BindAgentConnectionInput,
): Promise<boolean> {
  const workspaceId = input.workspaceId || DEFAULT_WORKSPACE;
  const { rows } = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_agent_connections
       (workspace_id, agent_id, connector_name, created_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id, agent_id, connector_name) DO NOTHING
     RETURNING id`,
    [workspaceId, input.agentId, input.connectorName, input.createdBy],
  );
  const created = rows.length > 0;
  if (created) {
    trackEvent("agent.connection_bound", input.createdBy, "admin", {
      agent_id: input.agentId,
      connector_name: input.connectorName,
    });
  }
  return created;
}

/**
 * Remove a connector↔agent association. Emits agent.connection_unbound ONLY
 * when a row was actually removed. Returns whether a row was removed.
 */
export async function unbindAgentConnection(
  workspaceId: string,
  agentId: string,
  connectorName: string,
  by: string,
): Promise<boolean> {
  const { rows } = await writeQuery<{ id: string }>(
    `DELETE FROM instinct_agent_connections
      WHERE workspace_id = $1 AND agent_id = $2 AND connector_name = $3
      RETURNING id`,
    [workspaceId || DEFAULT_WORKSPACE, agentId, connectorName],
  );
  const removed = rows.length > 0;
  if (removed) {
    trackEvent("agent.connection_unbound", by, "admin", {
      agent_id: agentId,
      connector_name: connectorName,
    });
  }
  return removed;
}

/** The connector_names bound to a single agent in this workspace. */
export async function listAgentConnectionNames(
  workspaceId: string,
  agentId: string,
): Promise<string[]> {
  const res = await safeQuery<{ connector_name: string }>(
    `SELECT connector_name FROM instinct_agent_connections
      WHERE workspace_id = $1 AND agent_id = $2
      ORDER BY connector_name`,
    [workspaceId || DEFAULT_WORKSPACE, agentId],
  );
  return res.rows.map((r) => r.connector_name);
}

/**
 * Roster view: agentId -> connector_names[] for every bound agent in the
 * workspace. One query, grouped in JS so listAgents stays N+1-free.
 */
export async function listConnectionsByAgent(
  workspaceId: string,
): Promise<Record<string, string[]>> {
  const res = await safeQuery<{ agent_id: string; connector_name: string }>(
    `SELECT agent_id, connector_name FROM instinct_agent_connections
      WHERE workspace_id = $1
      ORDER BY agent_id, connector_name`,
    [workspaceId || DEFAULT_WORKSPACE],
  );
  const grouped: Record<string, string[]> = {};
  for (const r of res.rows) {
    (grouped[r.agent_id] ??= []).push(r.connector_name);
  }
  return grouped;
}

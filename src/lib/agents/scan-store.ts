/**
 * Persist and read agent self-onboarding scans (migration 172).
 *
 * Saving a scan also marks the agent's scan_status complete, so the roster shows
 * which agents have learned the platform. The full model is stored as JSONB; a
 * later agent can read it to inherit the system model instead of rescanning.
 */

import { query, writeQuery, safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import type { AgentSystemModel } from "./scan";

export interface SavedScan {
  id: string;
  agentId: string;
  workspaceId: string;
  scanVersion: string;
  toolCount: number;
  allowedToolCount: number;
  capabilityCount: number;
  createdAt: string;
  model: AgentSystemModel;
}

/** Save a scan and flip the agent's scan_status to complete. */
export async function saveScan(model: AgentSystemModel): Promise<{ id: string }> {
  const { rows } = await writeQuery<{ id: string }>(
    `INSERT INTO instinct_agent_scans
       (agent_id, workspace_id, scan_version, model, tool_count,
        allowed_tool_count, capability_count)
     VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7)
     RETURNING id`,
    [
      model.agentId,
      model.workspaceId,
      model.scanVersion,
      JSON.stringify(model),
      model.summary.toolCount,
      model.summary.allowedToolCount,
      model.summary.capabilityCount,
    ],
    { expectRows: 1 },
  );

  // Best effort: marking scan_status must not fail the scan persist.
  try {
    await safeQuery(
      `UPDATE instinct_agents SET scan_status = 'complete', last_seen_at = NOW()
        WHERE id = $1 AND workspace_id = $2`,
      [model.agentId, model.workspaceId],
    );
  } catch {
    /* roster flag is cosmetic; the scan is saved */
  }

  trackEvent("agent.scan_completed", model.agentId, model.role, {
    agent_id: model.agentId,
    workspace_id: model.workspaceId,
    scan_version: model.scanVersion,
    tool_count: model.summary.toolCount,
    allowed_tool_count: model.summary.allowedToolCount,
    capability_count: model.summary.capabilityCount,
  });

  return { id: rows[0].id };
}

/** The most recent scan for an agent, or null. */
export async function getLatestScan(
  agentId: string,
  workspaceId: string,
): Promise<SavedScan | null> {
  const res = await safeQuery<Record<string, unknown>>(
    `SELECT id, agent_id, workspace_id, scan_version, model, tool_count,
            allowed_tool_count, capability_count, created_at::text AS created_at
       FROM instinct_agent_scans
      WHERE agent_id = $1 AND workspace_id = $2
      ORDER BY created_at DESC LIMIT 1`,
    [agentId, workspaceId],
  );
  const r = res.rows[0];
  if (!r) return null;
  return {
    id: String(r.id),
    agentId: String(r.agent_id),
    workspaceId: String(r.workspace_id),
    scanVersion: String(r.scan_version),
    toolCount: Number(r.tool_count),
    allowedToolCount: Number(r.allowed_tool_count),
    capabilityCount: Number(r.capability_count),
    createdAt: String(r.created_at),
    model: r.model as AgentSystemModel,
  };
}

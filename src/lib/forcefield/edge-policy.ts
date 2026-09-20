/**
 * Per-workspace inline-edge enforcement mode (server-only DB accessors). The
 * pure decision logic lives in ./edge-enforcement.ts; this is just the stored
 * mode. No row = monitor (safe default: shadow mode, never blocks).
 */
import { hasDatabase, query, safeQuery } from "@/lib/db";
import type { EdgeMode } from "@/lib/forcefield/edge-enforcement";

export async function getEdgePolicy(workspaceId: string): Promise<{ mode: EdgeMode }> {
  if (!hasDatabase()) return { mode: "monitor" };
  const res = await safeQuery<{ mode: string }>(
    `SELECT mode FROM instinct_edge_policy WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
  );
  const mode = res.rows[0]?.mode === "enforce" ? "enforce" : "monitor";
  return { mode };
}

export async function setEdgePolicy(workspaceId: string, mode: EdgeMode, updatedBy?: string): Promise<void> {
  if (!hasDatabase()) return;
  await query(
    `INSERT INTO instinct_edge_policy (workspace_id, mode, updated_by)
     VALUES ($1, $2, $3)
     ON CONFLICT (workspace_id) DO UPDATE SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [workspaceId, mode, updatedBy ?? null],
  );
}

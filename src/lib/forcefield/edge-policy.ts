/**
 * Per-workspace inline-edge enforcement policy (server-only DB accessors). The
 * pure decision logic lives in ./edge-enforcement.ts; this is just the stored
 * policy: the enforcement mode and whether proven-hostile actors are auto-blocked.
 * No row = monitor + no auto-block (safe default: shadow mode, never blocks).
 */
import { hasDatabase, query, safeQuery } from "@/lib/db";
import type { EdgeMode } from "@/lib/forcefield/edge-enforcement";

export interface EdgePolicy {
  mode: EdgeMode;
  /** When true (and mode is enforce), a proven-hostile operator is automatically
   *  added to the blocklist. Off by default; a deliberate opt-in. */
  autoBlock: boolean;
}

export async function getEdgePolicy(workspaceId: string): Promise<EdgePolicy> {
  if (!hasDatabase()) return { mode: "monitor", autoBlock: false };
  const res = await safeQuery<{ mode: string; auto_block: boolean }>(
    `SELECT mode, auto_block FROM instinct_edge_policy WHERE workspace_id = $1 LIMIT 1`,
    [workspaceId],
  );
  const row = res.rows[0];
  return { mode: row?.mode === "enforce" ? "enforce" : "monitor", autoBlock: row?.auto_block === true };
}

export async function setEdgePolicy(
  workspaceId: string,
  policy: { mode: EdgeMode; autoBlock?: boolean },
  updatedBy?: string,
): Promise<void> {
  if (!hasDatabase()) return;
  await query(
    `INSERT INTO instinct_edge_policy (workspace_id, mode, auto_block, updated_by)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (workspace_id) DO UPDATE
       SET mode = EXCLUDED.mode, auto_block = EXCLUDED.auto_block, updated_by = EXCLUDED.updated_by, updated_at = now()`,
    [workspaceId, policy.mode, policy.autoBlock === true, updatedBy ?? null],
  );
}

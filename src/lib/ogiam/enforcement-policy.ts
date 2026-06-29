/**
 * OGIAM per-capability enforcement posture (store + resolver).
 *
 * A row in ogiam_enforcement_policy (migration 209) pins, per (workspace,
 * capability), whether the gate ENFORCES (a blocking decision actually blocks)
 * or only MONITORS (records, never blocks). `resolveEnforcementMode` is what the
 * dispatcher calls to decide the mode for a given action.
 *
 * FAIL-SAFE BY CONSTRUCTION: when no row exists for a capability, resolution
 * falls back to the prior hardcoded default (agent principals enforce, the human
 * assistant monitors). The read goes through safeQuery, so a missing DATABASE_URL
 * or a transient DB error degrades to "no override" -> the default -> today's
 * exact behavior. Shipping this changes NOTHING until an admin sets a posture.
 *
 * The resolver runs on the gate hot path (once per governed action), so the
 * per-workspace policy is cached in-process with a short TTL to avoid a DB read
 * per decision. set/delete invalidate the workspace's cache entry.
 */
import { safeQuery, writeQuery } from "@/lib/db";
import type { OgiamEnforcementMode } from "./types";

export interface EnforcementPolicyRow {
  capability: string;
  mode: OgiamEnforcementMode;
  updatedAt: string;
  updatedBy: string | null;
}

interface DbRow {
  capability: string;
  mode: OgiamEnforcementMode;
  updated_at: string;
  updated_by: string | null;
}

/** Per-workspace cache of the capability->mode map. Short TTL: the gate hot path
 *  reads this once per action, so we avoid a DB round-trip per decision while
 *  keeping posture changes near-live. */
const TTL_MS = 30_000;
const cache = new Map<string, { at: number; map: Map<string, OgiamEnforcementMode> }>();

/** TEST-ONLY: clear the in-process cache so tests don't bleed into each other. */
export function __clearEnforcementCache(): void {
  cache.clear();
}

async function loadMap(workspaceId: string): Promise<Map<string, OgiamEnforcementMode>> {
  const hit = cache.get(workspaceId);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.map;

  const res = await safeQuery<DbRow>(
    `SELECT capability, mode, updated_at::text AS updated_at, updated_by
       FROM ogiam_enforcement_policy
      WHERE workspace_id = $1`,
    [workspaceId],
  );
  const map = new Map<string, OgiamEnforcementMode>();
  for (const r of res.rows) map.set(r.capability, r.mode);
  // Cache even an empty map (the common "no overrides" case) so the default path
  // doesn't hit the DB every action.
  cache.set(workspaceId, { at: Date.now(), map });
  return map;
}

/**
 * The effective enforcement mode for an action. A per-capability override wins;
 * otherwise the prior default (agents enforce, the human assistant monitors).
 * Never throws — fail-safe to the default.
 */
export async function resolveEnforcementMode(args: {
  workspaceId: string;
  capability: string;
  isAgent: boolean;
}): Promise<OgiamEnforcementMode> {
  const fallback: OgiamEnforcementMode = args.isAgent ? "enforce" : "monitor";
  try {
    const map = await loadMap(args.workspaceId || "default");
    return map.get(args.capability) ?? fallback;
  } catch {
    return fallback;
  }
}

/** All posture overrides for a workspace (admin read). */
export async function listEnforcementPolicy(workspaceId: string): Promise<EnforcementPolicyRow[]> {
  const res = await safeQuery<DbRow>(
    `SELECT capability, mode, updated_at::text AS updated_at, updated_by
       FROM ogiam_enforcement_policy
      WHERE workspace_id = $1
      ORDER BY capability ASC`,
    [workspaceId],
  );
  return res.rows.map((r) => ({
    capability: r.capability,
    mode: r.mode,
    updatedAt: r.updated_at,
    updatedBy: r.updated_by,
  }));
}

/** Upsert a capability's posture. Invalidates the workspace cache. */
export async function setEnforcementPolicy(args: {
  workspaceId: string;
  capability: string;
  mode: OgiamEnforcementMode;
  updatedBy: string;
}): Promise<void> {
  await writeQuery(
    `INSERT INTO ogiam_enforcement_policy (workspace_id, capability, mode, updated_by, updated_at)
     VALUES ($1, $2, $3, $4, NOW())
     ON CONFLICT (workspace_id, capability)
       DO UPDATE SET mode = EXCLUDED.mode, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
    [args.workspaceId, args.capability, args.mode, args.updatedBy],
  );
  cache.delete(args.workspaceId);
}

/** Remove an override (revert the capability to the default). */
export async function deleteEnforcementPolicy(workspaceId: string, capability: string): Promise<void> {
  await writeQuery(
    `DELETE FROM ogiam_enforcement_policy WHERE workspace_id = $1 AND capability = $2`,
    [workspaceId, capability],
  );
  cache.delete(workspaceId);
}

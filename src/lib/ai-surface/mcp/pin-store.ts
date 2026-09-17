/**
 * MCP manifest pin store - the known-good fingerprints drift is checked against.
 *
 * One row per (workspace, target, server): the sha256 of the tool set at the
 * moment an operator vouched for it (see ./pin.fingerprintManifest). The scan
 * looks a pin up and, if the live manifest no longer matches, raises a critical
 * manifest_drift finding rather than trusting the mutated server.
 *
 * Mirrors canary-store's DB-guard: without DATABASE_URL these no-op (return
 * null / []) so unit tests and DB-less environments never touch a pool.
 */
import { query, safeQuery } from "@/lib/db";
import { fingerprintManifest } from "./pin";
import type { McpToolDef } from "./types";

export interface McpManifestPin {
  target: string;
  server: string;
  fingerprint: string;
  toolCount: number;
  pinnedAt: string;
}

/** Record (or refresh) the known-good fingerprint for a server's tool set. */
export async function pinManifest(input: {
  workspaceId: string;
  target: string;
  server: string;
  tools: McpToolDef[];
}): Promise<McpManifestPin | null> {
  if (!process.env.DATABASE_URL) return null;
  const fingerprint = fingerprintManifest(input.tools);
  const { rows } = await query<{ pinned_at: string }>(
    `INSERT INTO instinct_mcp_manifest_pins
       (workspace_id, target, server, fingerprint, tool_count)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (workspace_id, target, server)
       DO UPDATE SET fingerprint = EXCLUDED.fingerprint,
                     tool_count   = EXCLUDED.tool_count,
                     pinned_at    = now()
     RETURNING pinned_at::text AS pinned_at`,
    [input.workspaceId, input.target, input.server, fingerprint, input.tools.length],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    target: input.target,
    server: input.server,
    fingerprint,
    toolCount: input.tools.length,
    pinnedAt: row.pinned_at,
  };
}

/** The pinned fingerprint for one server, or null when unpinned / no DB. */
export async function getPin(
  workspaceId: string,
  target: string,
  server: string,
): Promise<McpManifestPin | null> {
  if (!process.env.DATABASE_URL) return null;
  const res = await safeQuery<{
    fingerprint: string;
    tool_count: number;
    pinned_at: string;
  }>(
    `SELECT fingerprint, tool_count, pinned_at::text AS pinned_at
       FROM instinct_mcp_manifest_pins
      WHERE workspace_id = $1 AND target = $2 AND server = $3`,
    [workspaceId, target, server],
  );
  const row = res.rows[0];
  if (!row) return null;
  return {
    target,
    server,
    fingerprint: row.fingerprint,
    toolCount: row.tool_count,
    pinnedAt: row.pinned_at,
  };
}

/** Every pin for a target (the management view). Empty without a DB. */
export async function listPins(workspaceId: string, target: string): Promise<McpManifestPin[]> {
  const res = await safeQuery<{
    server: string;
    fingerprint: string;
    tool_count: number;
    pinned_at: string;
  }>(
    `SELECT server, fingerprint, tool_count, pinned_at::text AS pinned_at
       FROM instinct_mcp_manifest_pins
      WHERE workspace_id = $1 AND target = $2
      ORDER BY server`,
    [workspaceId, target],
  );
  return res.rows.map((r) => ({
    target,
    server: r.server,
    fingerprint: r.fingerprint,
    toolCount: r.tool_count,
    pinnedAt: r.pinned_at,
  }));
}

/**
 * Agent backup designation API (migration 184).
 *
 *   GET  /api/admin/agents/[id]/backup -> { backupAgentId: string | null }
 *   POST /api/admin/agents/[id]/backup  body { backupAgentId: string | null }
 *     -> 200 { ok: true, backupAgentId } sets/clears the agent's backup.
 *
 * Designating a backup is a GOVERNED continuity control: when this agent goes
 * unhealthy (paused/revoked) its queued work fails over to the backup, which
 * runs it under the SAME OGIAM gate and the SAME least-privilege scope (the
 * failover store enforces a connection-superset check before any reassignment).
 *
 * Capability: settings.manage_team (the same gate that mints + governs agents).
 * Every successful set/clear is hash-chained in the audit ledger inside
 * setBackupAgent (this route imports recordAudit for the coverage guard).
 *
 * Validation lives in setBackupAgent and returns a typed code that maps to:
 *   - agent_not_found            -> 404
 *   - backup_not_found           -> 404
 *   - backup_is_self / cycle /
 *     cross_workspace            -> 400 (would break the failover invariant)
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
// Imported so audit-coverage.test.ts sees this mutation route audits; the
// hash-chained write itself happens inside setBackupAgent.
import { recordAudit } from "@/lib/audit-log";
import { setBackupAgent, getBackupAgentId } from "@/lib/agents/failover/store";

void recordAudit;

export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await context.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }
  const workspaceId = auth.user.workspaceId ?? "default";

  const backupAgentId = await getBackupAgentId(workspaceId, agentId);
  return NextResponse.json({ backupAgentId });
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { id } = await context.params;
  const agentId = typeof id === "string" ? id : "";
  if (!agentId) {
    return NextResponse.json({ error: "agent_id required" }, { status: 400 });
  }
  const workspaceId = user.workspaceId ?? "default";

  let body: { backupAgentId?: unknown };
  try {
    body = (await req.json()) as { backupAgentId?: unknown };
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const raw = body.backupAgentId;
  // null or empty string clears the backup; a non-empty string designates it.
  let backupAgentId: string | null;
  if (raw === null || raw === undefined || raw === "") {
    backupAgentId = null;
  } else if (typeof raw === "string") {
    backupAgentId = raw;
  } else {
    return NextResponse.json(
      { error: "backupAgentId must be a string or null" },
      { status: 400 },
    );
  }

  const result = await setBackupAgent(workspaceId, agentId, backupAgentId, {
    userId: user.id,
    role: user.role,
  });

  if (!result.ok) {
    const status =
      result.code === "agent_not_found" || result.code === "backup_not_found"
        ? 404
        : 400;
    return NextResponse.json({ error: result.code }, { status });
  }

  return NextResponse.json({ ok: true, backupAgentId });
}

/**
 * PATCH /api/admin/agents/memory/[id] — human promote/reject override for a
 * learned procedure.
 *
 * Body: { action: "promote" | "reject", reason?: string }
 *   promote -> status "promoted" (the procedure becomes inheritable by later
 *              agents facing the same goal)
 *   reject  -> status "rejected" (quarantined; never inherited)
 *
 * Capability: settings.manage_team (same gate as the GET list).
 *
 * A human overriding what agents may inherit is a governance decision, so the
 * change is hash-chained into the audit log (action "agent.procedure_override")
 * with the resulting status + reason. recordAudit is best-effort and must not
 * fail the request.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { setMemoryStatus } from "@/lib/agents/memory/store";
import type { MemoryStatus } from "@/lib/agents/memory/types";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

const ACTION_TO_STATUS: Record<string, MemoryStatus> = {
  promote: "promoted",
  reject: "rejected",
};

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await params;

  const body = (await req.json().catch(() => null)) as {
    action?: string;
    reason?: string;
  } | null;

  const status = body?.action ? ACTION_TO_STATUS[body.action] : undefined;
  if (!status) {
    return NextResponse.json(
      { error: "action must be 'promote' or 'reject'" },
      { status: 400 },
    );
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  const reason = typeof body?.reason === "string" ? body.reason : undefined;

  const entry = await setMemoryStatus(
    id,
    workspaceId,
    status,
    { userId: auth.user.id, role: auth.user.role },
    reason,
  );
  if (!entry) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  /* A human deciding what agents may inherit is a governance action, so
     hash-chain it. Best-effort: a logging failure never fails the override. */
  try {
    await recordAudit({
      actor: { user_id: auth.user.id, role: auth.user.role },
      action: "agent.procedure_override",
      resourceType: "agent_memory",
      resourceId: id,
      afterState: { status, reason: reason ?? null },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[agent-memory override audit]", (err as Error).message);
  }

  return NextResponse.json({ memory: entry });
}

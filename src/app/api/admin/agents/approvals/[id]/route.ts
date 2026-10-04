import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { safeQuery } from "@/lib/db";
import {
  getPendingApproval,
  decidePendingApproval,
  markApprovalExecuted,
} from "@/lib/agents/approvals/store";
import { getAgent } from "@/lib/agents/store";
import { executeCreateExternalRecord } from "@/lib/assistant/tools/create-external-record-tool";
import { executeUpdateExternalRecord } from "@/lib/assistant/tools/update-external-record-tool";
import { executeOpenPr, validateBeforePr } from "@/lib/ai-code/open-pr-executor";

type WriteCtx = { userId: string; userRole: string; workspaceId?: string; agentId?: string; approvalId?: string };
type WriteOutcome = { ok: boolean; [k: string]: unknown };

/** The captured tool -> its real write executor. Only confirmation-gated CRM
 *  writes are approvable; anything else is rejected as unsupported. */
const EXECUTORS: Record<string, (params: never, ctx: WriteCtx) => Promise<WriteOutcome>> = {
  create_external_record: executeCreateExternalRecord as never,
  update_external_record: executeUpdateExternalRecord as never,
  // The factory's approved handoff: open a real PR from the gate-approved diff.
  "ai_code.open_pr": executeOpenPr as never,
};

/** Resolve the OWNER's role + workspace so the approved write runs AS the owner
 *  (the agent acts on their behalf), not the approver. Mirrors the executor's
 *  owner-role resolver. */
async function resolveOwner(ownerUserId: string): Promise<{ role: string; workspaceId: string } | null> {
  const { rows } = await safeQuery<{ role: string; workspace_id: string | null }>(
    `SELECT role, workspace_id FROM instinct_team_members WHERE id = $1 AND is_active = true`,
    [ownerUserId],
  );
  const r = rows[0];
  return r?.role ? { role: r.role, workspaceId: r.workspace_id ?? "default" } : null;
}

/**
 * POST /api/admin/agents/approvals/[id]  body: { action: "approve" | "reject" }
 *
 * approve: re-checks the agent KILL SWITCH (active), then executes the EXACT
 *   captured write on the owner's behalf, records the outcome + a hash-chained
 *   audit entry, and marks the approval executed. The atomic decide guards
 *   against a double-approve double-executing.
 * reject: records the decision; nothing mutates.
 */
export async function POST(req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";
  const { id } = await ctx.params;

  let body: { action?: string };
  try { body = (await req.json()) as { action?: string }; }
  catch { return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 }); }
  const action = body.action;
  if (action !== "approve" && action !== "reject") {
    return NextResponse.json({ error: "action must be 'approve' or 'reject'" }, { status: 400 });
  }

  const approval = await getPendingApproval(id, workspaceId);
  if (!approval) return NextResponse.json({ error: "approval not found" }, { status: 404 });
  if (approval.status !== "pending") return NextResponse.json({ error: `approval is ${approval.status}` }, { status: 409 });

  const meta = extractRequestMetadata(req);
  const audit = (a: string) =>
    recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: a, resourceType: "agent_approval", resourceId: id,
      ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

  // --- REJECT ---
  if (action === "reject") {
    const decided = await decidePendingApproval(id, workspaceId, user.id, "rejected");
    if (!decided) return NextResponse.json({ error: "approval is no longer pending" }, { status: 409 });
    await audit("agent.write.rejected");
    return NextResponse.json({ ok: true, status: "rejected" });
  }

  // --- APPROVE: kill-switch re-check ---
  const agent = await getAgent(approval.agentId, workspaceId);
  if (!agent || agent.state !== "active") {
    await decidePendingApproval(id, workspaceId, user.id, "rejected"); // stale: auto-reject
    await audit("agent.write.rejected_inactive_agent");
    return NextResponse.json({ error: "agent is not active (kill switch); approval auto-rejected" }, { status: 409 });
  }
  const executor = EXECUTORS[approval.tool];
  if (!executor) return NextResponse.json({ error: `tool ${approval.tool} is not an approvable write` }, { status: 400 });

  const owner = await resolveOwner(approval.ownerUserId);
  /* The write runs AS the owner, but the connector it may touch is still gated by
     the AGENT's binding (least-privilege): the agent proposed this write, so it
     must not reach a connector it isn't bound to even after owner approval. */
  const ownerCtx: WriteCtx = {
    userId: approval.ownerUserId,
    userRole: owner?.role ?? "member",
    workspaceId,
    agentId: approval.agentId,
    // Carry the approval id so pr_opened can echo it - the join key that links the
    // merged/rejected PR back to the memories this handoff used (provenance).
    approvalId: id,
  };

  // TIER-2 PRE-PR VALIDATION (opt-in via PREPR_VALIDATE_WORKFLOW). Run the TARGET
  // repo's OWN gate against the authored change BEFORE claiming/opening the PR, so
  // a convention violation or self-inconsistent artifact is caught at the source.
  // A not-yet-green result returns 202 and LEAVES THE APPROVAL PENDING, so the
  // user (or a UI poller) retries once validation settles - the atomic claim
  // below (the double-execute guard) therefore runs ONLY on the open-PR path.
  // When the env is unset this block is skipped entirely: the flow is unchanged.
  if (approval.tool === "ai_code.open_pr" && process.env.PREPR_VALIDATE_WORKFLOW) {
    const validation = await validateBeforePr(approval.params as never, ownerCtx);
    if (validation.verdict !== "allow") {
      await audit("agent.write.prepr_held");
      // 202 Accepted: the request was understood, the work is validating (or needs
      // a human) - it is NOT an error and the approval remains actionable.
      return NextResponse.json({ ok: false, status: "validating", validation }, { status: 202 });
    }
  }

  // Claim the approval atomically BEFORE executing so a concurrent approve cannot
  // run the write twice.
  const decided = await decidePendingApproval(id, workspaceId, user.id, "approved");
  if (!decided) return NextResponse.json({ error: "approval is no longer pending" }, { status: 409 });

  let outcome: WriteOutcome;
  try {
    outcome = await executor(approval.params as never, ownerCtx);
  } catch (err) {
    outcome = { ok: false, reason: (err as Error).message };
  }
  await markApprovalExecuted(id, workspaceId, outcome);
  await audit("agent.write.approved_executed");

  return NextResponse.json({ ok: outcome.ok === true, status: "executed", outcome });
}

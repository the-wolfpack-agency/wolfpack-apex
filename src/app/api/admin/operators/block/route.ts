/**
 * POST /api/admin/operators/block - block or unblock an operator by its durable
 * fingerprint. Capability: settings.manage_team. Body: { operatorKey, block, reason? }.
 * Blocking is a deliberate, reversible decision an admin makes from the board.
 * Responses: 200 { ok } | 400 invalid | 401/403.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { blockOperator, unblockOperator, getOperators } from "@/lib/agent-operators";
import { contributeHostileOperator } from "@/lib/forcefield/operator-reputation";
import { recordAudit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: { operatorKey?: unknown; block?: unknown; reason?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ error: "invalid_input" }, { status: 400 });
  }
  const operatorKey = typeof body.operatorKey === "string" ? body.operatorKey.trim() : "";
  if (!operatorKey) return NextResponse.json({ error: "invalid_input", detail: "operatorKey required" }, { status: 400 });
  const block = body.block !== false; // default to block
  const workspaceId = auth.user.workspaceId ?? "default";

  if (block) {
    await blockOperator({ workspaceId, operatorKey, reason: typeof body.reason === "string" ? body.reason.slice(0, 300) : undefined, blockedBy: auth.user.id });
    // A block is a human-confirmed hostile signal. If this workspace opted in to
    // the reputation network, contribute the opaque fingerprint AND this actor's
    // behavioral signature (behavior classes + the finer tradecraft tells) so the
    // rest of the network recognizes its METHODS, not just its fingerprint. All
    // non-PII: class/signal names only. Derived server-side from what we observed -
    // never trusted from the request. Gated + fail-safe inside the helper.
    const signature = await getOperators(workspaceId)
      .then((ops) => ops.find((o) => o.operatorKey === operatorKey))
      .catch(() => undefined);
    await contributeHostileOperator({
      workspaceId,
      operatorKey,
      severity: "hostile",
      behaviorClasses: signature?.behaviorClasses ?? [],
      tells: signature?.tells ?? [],
    }).catch(() => {});
  } else {
    await unblockOperator(workspaceId, operatorKey);
  }
  // Blocking/unblocking an operator is a security-relevant admin action.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: block ? "operator.blocked" : "operator.unblocked",
    resourceType: "agent_operator",
    resourceId: operatorKey,
    afterState: { workspace_id: workspaceId, blocked: block },
  }).catch(() => {});

  return NextResponse.json({ ok: true, operatorKey, blocked: block });
}

/**
 * Single agent principal API (OGIAM).
 *
 *   GET /api/admin/agents/[id]: read one agent's profile (workspace-scoped).
 *
 *   PATCH /api/admin/agents/[id]: lifecycle transition. Body { action } maps:
 *     resume -> active, pause -> paused, revoke -> revoked. A lifecycle change on
 *     an AI principal is security-relevant (revoke is a credential kill), so it
 *     is hash-chained in the audit log.
 *
 *     action: "set_ceiling" with { maxOperationsPerHour } changes how many
 *     operations the agent may run per hour. Same gate, same hash chain: raising
 *     what an agent is allowed to do unsupervised is exactly as security-relevant
 *     as pausing it, and "who lifted the limit" is the question an incident
 *     review asks first.
 *
 * Both gated on settings.manage_team. The secret hash never leaves the store, so
 * the returned agent record is safe to render.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getAgent, setAgentState, setAgentCeiling } from "@/lib/agents/store";
import type { AgentState } from "@/lib/agents/types";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

/** PATCH action -> target lifecycle state. The route never accepts a raw state. */
const ACTION_TO_STATE: Record<string, AgentState> = {
  resume: "active",
  pause: "paused",
  revoke: "revoked",
};

export async function GET(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId ?? "default";
  const agent = await getAgent(id, workspaceId);
  if (!agent) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }
  return NextResponse.json({ agent });
}

export async function PATCH(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  const { id } = await ctx.params;
  if (!id) {
    return NextResponse.json({ error: "id required" }, { status: 400 });
  }

  let body: { action?: unknown; maxOperationsPerHour?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "body must be JSON" },
      { status: 400 },
    );
  }

  const action = typeof body.action === "string" ? body.action : "";
  const workspaceId = user.workspaceId ?? "default";

  /* Ceiling change. Validated as a whole non-negative number: a fractional or
     negative ceiling is not a smaller limit, it is an unenforceable one, and a
     column that silently rounds it is a limit nobody can state. */
  if (action === "set_ceiling") {
    const raw = body.maxOperationsPerHour;
    const ceiling = typeof raw === "number" ? raw : NaN;
    if (!Number.isInteger(ceiling) || ceiling < 0 || ceiling > 100000) {
      return NextResponse.json(
        {
          error: "invalid_input",
          detail: "maxOperationsPerHour must be a whole number between 0 and 100000 (0 = unlimited)",
        },
        { status: 400 },
      );
    }
    const updated = await setAgentCeiling(id, workspaceId, ceiling, {
      userId: user.id,
      role: user.role,
    });
    if (!updated) {
      return NextResponse.json({ error: "not_found" }, { status: 404 });
    }
    try {
      await recordAudit({
        actor: { user_id: user.id, role: user.role },
        action: "agent.ceiling_changed",
        resourceType: "agent",
        resourceId: updated.id,
        afterState: { max_operations_per_hour: ceiling },
        ...extractRequestMetadata(req),
      });
    } catch (err) {
      console.error("[admin/agents PATCH ceiling audit]", (err as Error).message);
    }
    return NextResponse.json({ agent: updated });
  }

  const state = ACTION_TO_STATE[action];
  if (!state) {
    return NextResponse.json(
      { error: "invalid_input", detail: "action must be one of pause, resume, revoke, set_ceiling" },
      { status: 400 },
    );
  }

  const agent = await setAgentState(id, workspaceId, state, {
    userId: user.id,
    role: user.role,
  });
  if (!agent) {
    return NextResponse.json({ error: "not_found" }, { status: 404 });
  }

  /* A lifecycle change on an AI principal is security-relevant (revoke kills the
     credential). Hash-chain it with before/after state for the compliance trail. */
  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "agent.lifecycle_changed",
      resourceType: "agent",
      resourceId: agent.id,
      afterState: { action, state },
      ...extractRequestMetadata(req),
    });
  } catch (err) {
    console.error("[admin/agents PATCH audit]", (err as Error).message);
  }

  return NextResponse.json({ agent });
}

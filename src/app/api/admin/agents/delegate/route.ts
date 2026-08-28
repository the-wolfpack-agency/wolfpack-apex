/**
 * POST /api/admin/agents/delegate
 *
 * Give an external agent a task.
 *
 * THE DIRECTION IS THE POINT. /api/gate/authorize answers an agent that asks
 * whether it may act. /api/gate/complete runs its reasoning through our
 * router. Both are things the agent starts. This is the one where we start,
 * which is the difference between governing somebody else's agent and leading
 * it.
 *
 * The delivery carries no credential. It names the task, the workspace and the
 * gate to come back to, signed so the receiver can tell a real assignment from
 * anyone who learned its endpoint. The agent then works, calling the gate for
 * anything it needs authorized, exactly as it would have if it had started on
 * its own. Nothing about the trust model changes; only who initiates.
 *
 * A refusal returns 200 with the reason in the body. "That agent has no
 * endpoint" and "that agent did not answer" are answers to the operator's
 * question, not failures of their request, and a 4xx would send somebody
 * looking at their own permissions.
 *
 * Capability: settings.manage_team, the same gate as the rest of the agent
 * admin surface and the same one that mints the keys being delegated to.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit } from "@/lib/audit-log";
import { getDelegationTarget } from "@/lib/ogiam/api-keys";
import { delegateTask } from "@/lib/ogiam/delegate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** An instruction, not a document. */
const MAX_INSTRUCTION_CHARS = 4_000;

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;

  let body: { key_id?: unknown; instruction?: unknown } = {};
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json(
      { error: "invalid_input", detail: "body must be JSON" },
      { status: 400 },
    );
  }

  const keyId = typeof body.key_id === "string" ? body.key_id.trim() : "";
  const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";

  if (!keyId || !instruction) {
    return NextResponse.json(
      { error: "invalid_input", detail: "key_id and instruction are required" },
      { status: 400 },
    );
  }
  if (instruction.length > MAX_INSTRUCTION_CHARS) {
    return NextResponse.json(
      {
        error: "invalid_input",
        detail: `instruction may be at most ${MAX_INSTRUCTION_CHARS} characters`,
      },
      { status: 400 },
    );
  }

  const workspaceId = user.workspaceId ?? "default";
  const target = await getDelegationTarget(keyId, workspaceId);

  /* Scoped to the caller's own workspace by the lookup, so one tenant cannot
     task another's agent by guessing a key id. Not found and belonging to
     somebody else are deliberately the same answer. */
  if (!target.ok) {
    return NextResponse.json(
      {
        delegated: false,
        refused:
          target.reason === "revoked"
            ? "That agent's access has been revoked, so it can no longer be given work."
            : "No such agent in this workspace.",
      },
      { status: 200 },
    );
  }

  const result = await delegateTask({
    target: {
      keyId: target.keyId,
      workspaceId: target.workspaceId,
      agent: target.agent,
      delegationUrl: target.delegationUrl,
      capabilities: target.capabilities,
    },
    instruction,
    signingSecret: target.signingSecret,
    actor: { userId: user.id, role: user.role },
  });

  /* AUDITED BECAUSE WE REACHED OUT. "Who told that agent to do that" is the
     question asked when an agent does something surprising, and the honest
     answer has to name a person. The instruction is recorded because the task
     IS the decision; the response is not, because it is the agent's output
     rather than our action. */
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "ogiam.external_agent_delegated",
    resourceType: "gate_api_key",
    afterState: {
      key_id: target.keyId,
      agent: target.agent,
      workspace_id: workspaceId,
      instruction: instruction.slice(0, 500),
      delivered: result.delivered,
      refused: result.refused ?? null,
    },
  }).catch(() => undefined);

  return NextResponse.json(
    { delegated: result.delivered, ...result },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The stop button.
 *
 * setAgentsEnabled existed, was tested, wrote an audit entry and an analytics
 * event — and had no caller anywhere. The read path fail-closes correctly and
 * migration 227 seeds the row as enabled, so the switch could be READ on every
 * agent step and never FLIPPED by anyone. A stop button with no button.
 *
 * Found by the no-inert-controls sweep.
 *
 * WHY THIS IS A ROUTE AND NOT AN ENV VAR
 *
 * An environment variable takes a redeploy to change, and a stop that takes a
 * redeploy is not a stop — it is a preference with a deployment pipeline in
 * front of it. Migration 227's header says exactly this; the table was built
 * for an operator to flip NOW, and this is the surface that lets them.
 *
 * GET is deliberately included: an operator about to hit stop needs to know
 * whether it is already stopped, and whether the state can be read at all.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { extractRequestMetadata, recordAudit } from "@/lib/audit-log";
import { readContainmentState, setAgentsEnabled } from "@/lib/containment/state";

export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  const state = await readContainmentState(workspaceId);
  // `readable` is reported separately from `agentsEnabled` on purpose. "Stopped"
  // and "we could not tell" look identical to an operator otherwise, and only
  // one of them means someone made a decision.
  return NextResponse.json({ workspaceId, ...state }, { status: 200 });
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  let body: { enabled?: unknown; reason?: unknown };
  try {
    body = (await req.json()) as { enabled?: unknown; reason?: unknown };
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  // No default. Guessing which way an operator meant to move a kill switch is
  // the one place a helpful default is indefensible.
  if (typeof body.enabled !== "boolean") {
    return NextResponse.json({ error: "enabled_must_be_boolean" }, { status: 400 });
  }
  if (body.reason !== undefined && typeof body.reason !== "string") {
    return NextResponse.json({ error: "invalid_reason" }, { status: 400 });
  }

  // Stopping needs no reason to succeed — an operator halting agents in a hurry
  // must never be blocked by a form. Resuming is where the reason matters, and
  // setAgentsEnabled clears it on resume so a stale one cannot mislead.
  await setAgentsEnabled(workspaceId, body.enabled, {
    userId: user.id,
    role: user.role,
    reason: typeof body.reason === "string" ? body.reason.slice(0, 500) : undefined,
  });

  // Audit is best-effort and must never turn a successful stop into an error.
  // A ledger hiccup after the switch has moved is not a reason to tell the
  // operator their stop failed, because it did not.
  try {
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: body.enabled ? "containment.agents_resumed" : "containment.agents_stopped",
      resourceType: "containment",
      resourceId: workspaceId,
      afterState: { agents_enabled: body.enabled, reason: typeof body.reason === "string" ? body.reason : null },
      ...extractRequestMetadata(req),
    });
  } catch {
    /* The switch has already moved; the decision stands. */
  }

  const state = await readContainmentState(workspaceId);
  return NextResponse.json({ workspaceId, ...state }, { status: 200 });
}

/**
 * GET/POST /api/admin/forcefield/reputation-optin
 *
 * Read or set this workspace's opt-in to the cross-workspace operator-reputation
 * network. Off by default. Opting in to CONTRIBUTE shares this workspace's
 * confirmed-hostile blocks (opaque fingerprint + severity only) with the network;
 * opting in to CONSUME lets it see the network's known-bad reputation. A
 * data-sharing decision is security-relevant, so it is capability-gated + audited.
 *
 *   GET  -> { optIn: { contribute, consume } }
 *   POST { contribute, consume } -> { ok, optIn }
 *   401/403 via requireCapability("settings.manage_team")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getReputationOptIn, setReputationOptIn } from "@/lib/forcefield/operator-reputation";
import { recordAudit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const optIn = await getReputationOptIn(auth.user.workspaceId ?? "default");
  return NextResponse.json({ optIn });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: { contribute?: unknown; consume?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const optIn = { contribute: body.contribute === true, consume: body.consume === true };
  const workspaceId = auth.user.workspaceId ?? "default";
  await setReputationOptIn(workspaceId, optIn, auth.user.id);

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.reputation_optin_set",
    resourceType: "reputation_optin",
    resourceId: workspaceId,
    afterState: { contribute: optIn.contribute, consume: optIn.consume },
  }).catch(() => {});

  return NextResponse.json({ ok: true, optIn });
}

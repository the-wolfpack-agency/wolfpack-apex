/**
 * GET/POST /api/admin/forcefield/edge-policy
 *
 * Read or set this workspace's inline-edge enforcement mode. "monitor" (default)
 * is shadow mode - the edge decides + records but never blocks; "enforce" gates
 * for real. Flipping to enforce is a security-relevant change, so it is
 * capability-gated and audited.
 *
 *   GET  -> { mode }
 *   POST { mode } -> { ok, mode }
 *   400 invalid | 401/403 via requireCapability("settings.manage_team")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { getEdgePolicy, setEdgePolicy } from "@/lib/forcefield/edge-policy";
import { recordAudit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { mode } = await getEdgePolicy(auth.user.workspaceId ?? "default");
  return NextResponse.json({ mode });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: { mode?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  if (body.mode !== "monitor" && body.mode !== "enforce") {
    return NextResponse.json({ error: "invalid_input", detail: "mode must be monitor or enforce" }, { status: 400 });
  }
  const workspaceId = auth.user.workspaceId ?? "default";
  await setEdgePolicy(workspaceId, body.mode, auth.user.id);

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.edge_policy_set",
    resourceType: "edge_policy",
    resourceId: workspaceId,
    afterState: { mode: body.mode },
  }).catch(() => {});

  return NextResponse.json({ ok: true, mode: body.mode });
}

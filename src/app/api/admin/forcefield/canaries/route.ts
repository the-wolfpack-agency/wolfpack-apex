/**
 * /api/admin/forcefield/canaries - manage the Forcefield deception grid.
 *
 *   GET    -> the workspace's canaries, DISPLAY-safe (masked hints, never the
 *             decoy value - exposing it would defeat the deception).
 *   POST   { kind, value, seededIn } -> seed a decoy. kind is one of
 *             token | route | row | tool. Returns the masked display row.
 *   DELETE ?id=<id> -> retire a decoy (soft-disable so it no longer trips).
 *
 * A decoy is something nothing legitimate ever touches, so seeding and retiring
 * them is a security-relevant action: capability settings.manage_team, hash-chain
 * AUDITED, analytics-emitted. The create path's analytics (forcefield.canary_seeded)
 * lives in the store; retire emits forcefield.canary_retired here.
 *
 * Returns: 200 | 400 (bad body) | 401/403 (auth).
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { recordAudit } from "@/lib/audit-log";
import {
  listCanariesForDisplay,
  createCanary,
  deactivateCanary,
  isCanaryKind,
} from "@/lib/forcefield/canary-store";

const MAX_VALUE = 4096;
const MAX_SEEDED_IN = 512;

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const canaries = await listCanariesForDisplay(auth.user.workspaceId ?? "default");
  return NextResponse.json({ canaries });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const b = (body ?? {}) as { kind?: unknown; value?: unknown; seededIn?: unknown };
  const kind = b.kind;
  const value = typeof b.value === "string" ? b.value.trim() : "";
  const seededIn = typeof b.seededIn === "string" ? b.seededIn.trim() : "";

  if (!isCanaryKind(kind)) {
    return NextResponse.json({ error: "kind must be one of token, route, row, tool" }, { status: 400 });
  }
  if (!value) return NextResponse.json({ error: "value is required" }, { status: 400 });
  if (value.length > MAX_VALUE) return NextResponse.json({ error: "value too large" }, { status: 400 });
  if (!seededIn) return NextResponse.json({ error: "seededIn is required" }, { status: 400 });
  if (seededIn.length > MAX_SEEDED_IN) return NextResponse.json({ error: "seededIn too large" }, { status: 400 });

  const workspaceId = auth.user.workspaceId ?? "default";
  const canary = await createCanary({ workspaceId, kind, value, seededIn, createdBy: auth.user.id });
  if (!canary) {
    return NextResponse.json({ error: "canary store unavailable" }, { status: 503 });
  }

  // Seeding a decoy is a security-relevant control change: hash-chain it. The
  // decoy value is NEVER audited or logged - only the masked hint + where seeded.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.canary_seeded",
    resourceType: "forcefield_canary",
    resourceId: `${workspaceId}:${canary.id}`,
    afterState: { kind: canary.kind, seeded_in: canary.seededIn, value_hint: canary.valueHint },
  });

  return NextResponse.json({ canary }, { status: 201 });
}

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const id = req.nextUrl.searchParams.get("id")?.trim();
  if (!id) return NextResponse.json({ error: "id is required" }, { status: 400 });

  const workspaceId = auth.user.workspaceId ?? "default";
  const retired = await deactivateCanary(workspaceId, id);
  if (!retired) return NextResponse.json({ error: "canary not found" }, { status: 404 });

  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.canary_retired",
    resourceType: "forcefield_canary",
    resourceId: `${workspaceId}:${id}`,
    afterState: { active: false },
  });
  trackEvent("forcefield.canary_retired", auth.user.id, auth.user.role, { workspace_id: workspaceId });

  return NextResponse.json({ ok: true });
}

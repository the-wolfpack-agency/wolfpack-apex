/**
 * GET/POST /api/admin/forcefield/delegation-issuers
 *
 * Manage the delegation issuers this workspace trusts (Know the Principal). An
 * inbound agent's signed delegation is only ever "verified" if it was signed by
 * an issuer registered here; everything else is "claimed". Registering or
 * rotating an issuer secret is security-relevant, so it is capability-gated and
 * audited. Secrets are write-only: GET never returns them.
 *
 *   GET  -> { issuers: [{ issuer, algorithm, allowedScopes, createdAt }] }
 *   POST { issuer, secret, allowedScopes? } -> { ok }
 *   400 invalid | 401/403 via requireCapability("settings.manage_team")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listDelegationIssuers, registerDelegationIssuer } from "@/lib/forcefield/principal";
import { recordAudit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const issuers = await listDelegationIssuers(auth.user.workspaceId ?? "default");
  return NextResponse.json({ issuers });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: { issuer?: unknown; secret?: unknown; allowedScopes?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const issuer = typeof body.issuer === "string" ? body.issuer.trim() : "";
  const secret = typeof body.secret === "string" ? body.secret : "";
  if (!issuer || issuer.length > 200) return NextResponse.json({ error: "invalid_input", detail: "issuer required" }, { status: 400 });
  if (secret.length < 16) return NextResponse.json({ error: "invalid_input", detail: "secret must be at least 16 characters" }, { status: 400 });
  const allowedScopes = Array.isArray(body.allowedScopes)
    ? body.allowedScopes.filter((x): x is string => typeof x === "string").slice(0, 50)
    : [];

  const workspaceId = auth.user.workspaceId ?? "default";
  await registerDelegationIssuer({ workspaceId, issuer, secret, allowedScopes, createdBy: auth.user.id });

  // The secret is never logged or echoed; only that an issuer was registered.
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.delegation_issuer_registered",
    resourceType: "delegation_issuer",
    resourceId: issuer,
    afterState: { workspace_id: workspaceId, allowed_scopes: allowedScopes },
  }).catch(() => {});

  return NextResponse.json({ ok: true, issuer });
}

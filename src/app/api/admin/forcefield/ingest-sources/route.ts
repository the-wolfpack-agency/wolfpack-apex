/**
 * GET/POST /api/admin/forcefield/ingest-sources
 *
 * Manage the trusted telemetry-ingest sources (gap #1). A source registers its
 * ES256 public key; when ingest signing is enforced, only batches signed by a
 * registered source are accepted. Capability-gated + audited. Public keys only,
 * so GET returning them is fine.
 *
 *   GET  -> { sources: [{ sourceId, algorithm, createdAt }], enforced }
 *   POST { sourceId, publicKey } -> { ok }
 *   400 invalid | 401/403 via requireCapability("settings.manage_team")
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { listIngestSources, registerIngestSource, ingestSigningEnforced } from "@/lib/forcefield/ingest-signing";
import { recordAudit } from "@/lib/audit-log";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const sources = await listIngestSources();
  return NextResponse.json({ sources, enforced: ingestSigningEnforced() });
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: { sourceId?: unknown; publicKey?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const sourceId = typeof body.sourceId === "string" ? body.sourceId.trim() : "";
  const publicKey = body.publicKey && typeof body.publicKey === "object" && !Array.isArray(body.publicKey) ? (body.publicKey as Record<string, unknown>) : null;
  if (!sourceId || sourceId.length > 200) return NextResponse.json({ error: "invalid_input", detail: "sourceId required" }, { status: 400 });
  if (!publicKey || publicKey.kty !== "EC") return NextResponse.json({ error: "invalid_input", detail: "publicKey must be an EC JWK" }, { status: 400 });

  await registerIngestSource({ sourceId, publicKey, createdBy: auth.user.id });
  await recordAudit({
    actor: { user_id: auth.user.id, role: auth.user.role },
    action: "forcefield.ingest_source_registered",
    resourceType: "ingest_source",
    resourceId: sourceId,
    afterState: { algorithm: "es256" },
  }).catch(() => {});

  return NextResponse.json({ ok: true, sourceId });
}

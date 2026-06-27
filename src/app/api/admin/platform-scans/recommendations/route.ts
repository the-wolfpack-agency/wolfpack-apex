/**
 * Automation recommendations: gate-governed PROPOSALS derived from a target's
 * SystemProfile + open findings. This route ONLY proposes + persists + triages;
 * it never executes anything. Execution stays behind the existing
 * capture -> approve -> execute gate, so there is no active risk to a client.
 *
 *   POST   { platform }            -> generate + persist + return recommendations
 *   GET    ?platform&status        -> list recommendations
 *   PATCH  { id, status }          -> triage (accept / dismiss / implemented)
 *
 * Learning tie-in: recommendations persist (source of truth) + ingest into the
 * Brain (semantic recall) + emit analytics + write the hash-chained audit log.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { listFindings, listScans } from "@/lib/platform-scan/store";
import { getSystemProfile } from "@/lib/platform-scan/profile/store";
import { recommendAutomations } from "@/lib/platform-scan/recommend/engine";
import { saveRecommendations, listRecommendations, triageRecommendation } from "@/lib/platform-scan/recommend/store";
import { ingestRecommendation } from "@/lib/platform-scan/recommend/brain-ingest";
import type { RecStatus } from "@/lib/platform-scan/recommend/types";

const VALID_STATUS: RecStatus[] = ["proposed", "accepted", "dismissed", "implemented"];

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const body = await req.json().catch(() => ({}));
  const platform = typeof (body as { platform?: unknown }).platform === "string" ? (body as { platform: string }).platform.trim() : "";
  if (!platform) return NextResponse.json({ error: "platform_required" }, { status: 400 });

  const [profileRow, findings, scans] = await Promise.all([
    getSystemProfile(workspaceId, platform),
    listFindings(workspaceId, { status: "open", platform, limit: 500 }),
    listScans(workspaceId, 100),
  ]);

  const recs = recommendAutomations({
    platform,
    profile: profileRow?.profile ?? null,
    findings,
    scanCount: scans.filter((s) => s.platform === platform).length,
  });

  await saveRecommendations(workspaceId, platform, recs);
  await Promise.all(recs.map((r) => ingestRecommendation(platform, r))); // best effort each

  const criticals = recs.filter((r) => r.priority === "critical").length;
  trackEvent("platform.recommendations_generated", user.id, user.role, { platform, count: recs.length, criticals });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.recommendations_generated",
    resourceType: "automation_recommendation",
    resourceId: platform,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { platform, count: recs.length, criticals },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, platform, count: recs.length, recommendations: recs });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";
  const { searchParams } = new URL(req.url);
  const statusRaw = searchParams.get("status");
  const status = statusRaw && VALID_STATUS.includes(statusRaw as RecStatus) ? (statusRaw as RecStatus) : undefined;
  const rows = await listRecommendations(workspaceId, {
    platform: searchParams.get("platform") ?? undefined,
    status,
  });
  return NextResponse.json({ recommendations: rows });
}

export async function PATCH(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const body = await req.json().catch(() => ({}));
  const id = typeof (body as { id?: unknown }).id === "string" ? (body as { id: string }).id : "";
  const status = (body as { status?: unknown }).status as RecStatus;
  if (!id || !VALID_STATUS.includes(status)) {
    return NextResponse.json({ error: "id_and_valid_status_required" }, { status: 400 });
  }

  const updated = await triageRecommendation(workspaceId, id, status, user.id);
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  trackEvent("platform.recommendation_triaged", user.id, user.role, { status, key: updated.key });
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.recommendation_triaged",
    resourceType: "automation_recommendation",
    resourceId: id,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { status, key: updated.key },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, recommendation: updated });
}

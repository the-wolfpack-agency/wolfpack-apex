/**
 * POST /api/admin/platform-scans/profile - build + persist a SystemProfile for a
 * target, the agent's knowledge model that powers automation creation, the
 * report System Map, and grounded diagnosis. Deterministic static introspection
 * of the target repo (zero tokens): surface, data model (migrations), external
 * integrations (dependencies), auth posture, and current risk surface.
 *
 * GET ?platform=X returns the saved profile (or ?all=1 lists every profile).
 *
 * Learning tie-in: the profile is persisted (source of truth) AND ingested into
 * the Brain (semantic recall), the action emits platform.system_profiled, and is
 * recorded in the hash-chained audit log. No data lost.
 */
import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { resolveScanTarget } from "@/lib/platform-scan/manifests";
import { discoverRepoFiles } from "@/lib/platform-scan/static/discover-files";
import { defaultReadFile } from "@/lib/platform-scan/static/scan";
import { summarizeFindings } from "@/lib/platform-scan/store";
import { buildSystemProfile } from "@/lib/platform-scan/profile/build";
import { saveSystemProfile, getSystemProfile, listSystemProfiles } from "@/lib/platform-scan/profile/store";
import { ingestSystemProfile } from "@/lib/platform-scan/profile/brain-ingest";

export async function POST(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  const body = await req.json().catch(() => ({}));
  const platform = typeof (body as { platform?: unknown }).platform === "string" ? (body as { platform: string }).platform.trim() : "";
  if (!platform) {
    return NextResponse.json({ error: "platform_required" }, { status: 400 });
  }

  const manifest = await resolveScanTarget(workspaceId, platform);
  if (!manifest) {
    return NextResponse.json({ error: "unknown_platform" }, { status: 404 });
  }
  if (!manifest.static) {
    // Profiling reads the target's repo; without a static (repo) target there is
    // nothing to introspect deterministically.
    return NextResponse.json({ error: "no_static_target" }, { status: 400 });
  }

  const { owner, repo, ref } = manifest.static;
  const readFile = defaultReadFile(owner, repo, ref);

  const profile = await buildSystemProfile(
    { platform, routes: manifest.routes },
    {
      discoverFiles: () => discoverRepoFiles(owner, repo, ref),
      readFile,
      summarize: () => summarizeFindings(workspaceId, platform),
    },
  );

  await saveSystemProfile(workspaceId, profile);
  await ingestSystemProfile(profile); // best effort; never throws

  trackEvent("platform.system_profiled", user.id, user.role, {
    platform,
    entities: profile.entities.length,
    integrations: profile.integrations.length,
    routes: profile.authModel.publicRoutes + profile.authModel.protectedRoutes,
    criticals: profile.riskSummary.critical,
  });

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.system_profiled",
    resourceType: "system_profile",
    resourceId: platform,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { platform, entities: profile.entities.length, integrations: profile.integrations.length },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ ok: true, platform, profile });
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  const { searchParams } = new URL(req.url);
  if (searchParams.get("all") === "1") {
    return NextResponse.json({ profiles: await listSystemProfiles(workspaceId) });
  }
  const platform = searchParams.get("platform") ?? "";
  if (!platform) {
    return NextResponse.json({ error: "platform_required" }, { status: 400 });
  }
  const row = await getSystemProfile(workspaceId, platform);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ profile: row.profile, generatedAt: row.generatedAt });
}

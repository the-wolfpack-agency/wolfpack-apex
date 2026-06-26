import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { trackEvent } from "@/lib/analytics";
import { scanPlatform } from "@/lib/platform-scan/engine";
import { scanSource, defaultReadFile } from "@/lib/platform-scan/static/scan";
import { discoverRepoFiles } from "@/lib/platform-scan/static/discover-files";
import { discoverRoutes, mergeManifest } from "@/lib/platform-scan/discover";
import { establishSession, establishOAuthPasswordSession } from "@/lib/platform-scan/session";
import { probeApi } from "@/lib/platform-scan/api-probe";
import { loadConnectorCredentials } from "@/lib/assistant/connectors/credentials";
import { resolveScanTarget, type ScanManifest } from "@/lib/platform-scan/manifests";
import type { PlatformScanResult } from "@/lib/platform-scan/types";

/**
 * Establish an authenticated session for a platform that needs login, returning
 * the auth headers to send AND the base URL to scan against (oauth providers like
 * Salesforce return a per-org instance_url that differs from the login host).
 *   - username_password -> form login -> { Cookie }, base = manifest.baseUrl
 *   - oauth_password    -> token exchange -> { Authorization: Bearer }, base = instance_url
 * Returns null when there's no login config / no connection / login fails (the
 * scan then runs unauthenticated — still valid, just shallower).
 */
async function resolveAuth(
  workspaceId: string,
  manifest: ScanManifest,
): Promise<{ headers: Record<string, string>; baseUrl: string } | null> {
  if (!manifest.login) return null;
  const creds = await loadConnectorCredentials(workspaceId, manifest.login.connectorName);
  if (!creds) return null;

  if (creds.authType === "username_password" && creds.username && creds.password) {
    const session = await establishSession({
      baseUrl: manifest.baseUrl,
      loginPath: creds.loginPath ?? manifest.login.loginPath,
      username: creds.username,
      password: creds.password,
      sessionCookieName: creds.sessionCookieName ?? manifest.login.sessionCookieName,
    });
    return session ? { headers: { Cookie: session.cookie }, baseUrl: manifest.baseUrl } : null;
  }

  if (creds.authType === "oauth_password" && creds.clientId && creds.clientSecret && creds.username && creds.password) {
    const session = await establishOAuthPasswordSession({
      baseUrl: manifest.baseUrl,
      loginPath: creds.loginPath ?? manifest.login.loginPath,
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      username: creds.username,
      password: creds.password,
    });
    // Scan the per-org instance the token is scoped to, with the bearer.
    return session ? { headers: { Authorization: session.authHeader }, baseUrl: session.instanceUrl } : null;
  }

  return null;
}
import {
  recordScan,
  listFindings,
  type ScanFindingRow,
} from "@/lib/platform-scan/store";

/**
 * POST /api/admin/platform-scans -> run a black-box platform scan and persist
 * its findings. Gated on settings.manage_team (the same gate as the other
 * agent-admin routes). The manifest pins the target baseUrl + the route specs;
 * the engine never throws, so a hung/erroring target still yields findings.
 */
export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const { user } = auth;
  const workspaceId = user.workspaceId ?? "default";

  let body: { platform?: string; mode?: string };
  try {
    body = (await req.json()) as { platform?: string; mode?: string };
  } catch {
    body = {};
  }
  const platform = body.platform ?? "wolfpack-auto";
  const mode = body.mode === "static" || body.mode === "api" ? body.mode : "http";

  // Curated platform OR a saved client connection (so any connected system is scannable).
  const manifest = await resolveScanTarget(workspaceId, platform);
  if (!manifest) {
    return NextResponse.json({ error: "unknown_platform" }, { status: 404 });
  }
  if (mode === "static" && !manifest.static) {
    return NextResponse.json({ error: "no_static_target" }, { status: 400 });
  }
  if (mode === "api" && (!manifest.apiEndpoints || manifest.apiEndpoints.length === 0)) {
    return NextResponse.json({ error: "no_api_endpoints" }, { status: 400 });
  }

  let result: PlatformScanResult;
  if (mode === "api" && manifest.apiEndpoints) {
    // Gray-box API contract probe: log in (if the platform needs it), then
    // exercise the target's API for auth-enforcement + input-validation bugs.
    const auth = await resolveAuth(workspaceId, manifest);
    trackEvent("platform.scan_started", user.id, user.role, {
      platform,
      mode,
      route_count: manifest.apiEndpoints.length,
      authenticated: !!auth,
    });
    const findings = await probeApi({
      baseUrl: auth?.baseUrl ?? manifest.baseUrl,
      authHeaders: auth?.headers,
      endpoints: manifest.apiEndpoints,
    });
    const flagged = new Set(findings.map((f) => f.route)).size;
    result = {
      platform,
      baseUrl: manifest.baseUrl,
      routeCount: manifest.apiEndpoints.length,
      okCount: manifest.apiEndpoints.length - flagged,
      findings,
    };
  } else if (mode === "static" && manifest.static) {
    // White-box source scan. Discover the target repo's whole page/route surface
    // from its git tree and union with the curated seed (the seed guarantees the
    // known high-risk pages are covered even if discovery is empty). The detectors
    // then run over every file, not a hardcoded 9.
    const { owner, repo, ref, paths: seed } = manifest.static;
    const discovered = await discoverRepoFiles(owner, repo, ref);
    const paths = discovered.length > 0
      ? Array.from(new Set([...seed, ...discovered]))
      : seed;
    trackEvent("platform.scan_started", user.id, user.role, {
      platform,
      mode,
      route_count: paths.length,
      discovered_count: discovered.length,
    });
    result = await scanSource({
      platform,
      owner,
      repo,
      ref,
      paths,
      readFile: defaultReadFile(owner, repo, ref),
    });
  } else {
    // Black-box HTTP crawl. Merge sitemap-discovered routes with the curated seed
    // so the scan covers the real surface, not just the hardcoded list. If the
    // platform uses form login + a Connection exists, log in first and crawl
    // AUTHENTICATED so behind-login pages are reached (not just login redirects).
    const auth = await resolveAuth(workspaceId, manifest);
    const scanBaseUrl = auth?.baseUrl ?? manifest.baseUrl;
    const discovered = await discoverRoutes(scanBaseUrl);
    const routes = mergeManifest(manifest.routes, discovered);
    trackEvent("platform.scan_started", user.id, user.role, {
      platform,
      mode,
      route_count: routes.length,
      discovered_count: discovered.length,
      authenticated: !!auth,
    });
    result = await scanPlatform({
      workspaceId,
      platform,
      baseUrl: scanBaseUrl,
      routes,
      headers: auth?.headers,
      authenticated: !!auth,
    });
  }

  const { scanId, findingCount, criticalCount } = await recordScan({
    workspaceId,
    actorId: user.id,
    actorRole: user.role,
    result,
  });

  // Audit the scan run: an agent action against an external platform is a
  // security-relevant event (hash-chained, immutable). Best effort.
  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "platform.scan_run",
    resourceType: "platform_scan",
    resourceId: scanId,
    ipAddress: meta.ipAddress, userAgent: meta.userAgent, requestId: meta.requestId,
    afterState: { platform, finding_count: findingCount, critical_count: criticalCount },
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({
    ok: true,
    platform,
    mode,
    scanId,
    findingCount,
    criticalCount,
    findings: result.findings,
  });
}

/**
 * GET /api/admin/platform-scans -> the workspace's scan findings. Optional
 * ?status and ?platform narrow the queue (used by the findings triage UI).
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const workspaceId = auth.user.workspaceId ?? "default";

  const params = req.nextUrl.searchParams;
  const status =
    (params.get("status") as ScanFindingRow["status"] | null) ?? undefined;
  const platform = params.get("platform") ?? undefined;

  const findings = await listFindings(workspaceId, { status, platform });
  return NextResponse.json({ findings });
}

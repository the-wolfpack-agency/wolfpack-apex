/**
 * GET /api/forcefield/integrations/vercel/callback
 *
 * The OAuth callback Vercel redirects to after a client installs + authorizes our
 * Vercel integration. It exchanges the one-time `code` (that exchange IS the auth -
 * only a real code issued to our registered integration works), mints a Forcefield
 * tenant, and writes the site's config straight into the project's env vars. The
 * client types nothing.
 *
 * Dark by default: unconfigured (no integration credentials) -> 501, a no-op, so
 * merging this changes nothing until the integration is registered. Watch-first:
 * the env it writes has FORCEFIELD_ENFORCE=off. Fail-safe: any provisioning failure
 * returns a clean status, never a stack trace, and never a half-trusted redirect.
 *
 * PUBLIC: unauthenticated by design - the platform redirects the user's browser
 * here before any session exists, so it is NOT capability-gated. Authorization is
 * the one-time OAuth `code` exchange (only a real code issued to our registered
 * integration succeeds). Same posture as forcefield/observe + the stripe-webhook.
 */
import { NextRequest, NextResponse } from "next/server";
import {
  isVercelIntegrationConfigured,
  provisionVercelProject,
  type FetchLike,
} from "@/lib/forcefield-web/marketplace/vercel";
import { trackEvent } from "@/lib/analytics";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const liveFetch: FetchLike = (url, init) => fetch(url, init);

/** Only return the user to a Vercel-owned `next`, or same-origin. Anything else is
 *  dropped (open-redirect defense), same posture as the OAuth returnTo rule. */
function safeNext(next: string | null, origin: string): string | null {
  if (!next) return null;
  try {
    const u = new URL(next, origin);
    if (u.protocol !== "https:") return null;
    if (u.origin === origin) return u.toString();
    if (u.hostname === "vercel.com" || u.hostname.endsWith(".vercel.com")) return u.toString();
    return null;
  } catch {
    return null;
  }
}

// PUBLIC: unauthenticated (no user session); authorized by the one-time OAuth
// code exchange below, not a capability. See the file header.
export async function GET(req: NextRequest): Promise<NextResponse> {
  if (!isVercelIntegrationConfigured()) {
    // Dark until the integration is registered + its credentials set.
    return NextResponse.json({ ok: false, error: "integration_not_configured" }, { status: 501 });
  }

  const url = new URL(req.url);
  const code = url.searchParams.get("code") ?? "";
  const projectId = url.searchParams.get("projectId") ?? url.searchParams.get("configurationId") ?? "";
  const site = url.searchParams.get("site") || projectId;
  const clientName = url.searchParams.get("teamName") || site || "Vercel site";
  const next = safeNext(url.searchParams.get("next"), url.origin);
  const redirectUri = `${url.origin}/api/forcefield/integrations/vercel/callback`;

  if (!code || !projectId) {
    return NextResponse.json({ ok: false, error: "missing_code_or_project" }, { status: 400 });
  }

  const result = await provisionVercelProject(
    { code, redirectUri, projectId, clientName, siteLabel: site },
    { fetchImpl: liveFetch },
  );

  if (!result.ok) {
    const status = result.reason === "exchange_failed" ? 401 : result.reason === "unconfigured" ? 501 : 502;
    return NextResponse.json({ ok: false, error: result.reason ?? "provision_failed" }, { status });
  }

  void trackEvent("forcefield.integration_provisioned", `tenant:${result.tenantId}`, "forcefield", {
    provider: "vercel", site,
  });

  // Return the user to Vercel's flow if provided + trusted, else a plain success.
  if (next) return NextResponse.redirect(next, { status: 302 });
  return NextResponse.json({ ok: true, site, enforce: "off" }, { status: 200 });
}

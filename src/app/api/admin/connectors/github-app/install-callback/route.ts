/**
 * /api/admin/connectors/github-app/install-callback
 *
 * GitHub redirects here AFTER the client installs the App ("Setup URL" in the
 * App settings). The redirect is a browser navigation carrying:
 *   ?installation_id=<numeric>&setup_action=install
 *
 * We record the installation for the CALLER'S workspace (resolved from the
 * session cookie - requireCapability's cookie fallback handles the navigation,
 * no Authorization header is present on a top-level redirect) and bounce back to
 * the admin GitHub App page with a success/error query param the UI surfaces as
 * a toast. The workspace is NEVER taken from the query string, so the redirect
 * can only link an installation into the signed-in user's own tenant.
 *
 * Mirrors the OAuth-callback idiom of the connectors page (?oauth_connected /
 * ?oauth_error), here as ?github_app_connected / ?github_app_error.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { linkInstallation } from "@/lib/github-app";

const UI_PATH = "/admin/connectors/github-app";

function redirectBack(req: NextRequest, params: Record<string, string>): NextResponse {
  const url = new URL(UI_PATH, req.nextUrl.origin);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return NextResponse.redirect(url);
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) {
    /* Not signed in / not permitted. Bounce to login preserving intent so the
       user can sign in and re-run the install link, rather than a blank 401. */
    const loginUrl = new URL("/login", req.nextUrl.origin);
    loginUrl.searchParams.set("next", `${UI_PATH}`);
    return NextResponse.redirect(loginUrl);
  }
  const user = auth.user;
  const workspaceId = auth.user.workspaceId;

  const installationId = req.nextUrl.searchParams.get("installation_id")?.trim() ?? "";
  const setupAction = req.nextUrl.searchParams.get("setup_action") ?? "";

  if (!/^[0-9]{1,20}$/.test(installationId)) {
    return redirectBack(req, {
      github_app_error: "missing_installation_id",
    });
  }

  try {
    await linkInstallation({
      workspaceId,
      installationId,
      linkedBy: user.id,
      actorRole: user.role,
    });
  } catch (e) {
    console.warn("[github-app] install-callback link failed:", (e as Error).message);
    return redirectBack(req, { github_app_error: "link_failed" });
  }

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "connector.github_app.linked",
    resourceType: "github_app_installation",
    resourceId: `${workspaceId}:${installationId}`,
    afterState: {
      workspace_id: workspaceId,
      installation_id: installationId,
      setup_action: setupAction || null,
      via: "install_callback",
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return redirectBack(req, { github_app_connected: installationId });
}

/**
 * POST /api/admin/connectors/[name]/verify
 *
 * Health-check a connector by issuing a single low-cost read against
 * the vendor's API. Used by the admin UI's "Verify connection" affordance
 * — proves the stored tokens still work without waiting for a user
 * query.
 *
 * Strategy: call the connector's searchRecords with a 2-char query.
 * For Salesforce this fires a `SELECT … WHERE Name LIKE '%xx%' LIMIT 1`
 * SOQL — cheapest possible read. We don't care about the result, only
 * whether the call succeeded (proves the token works) or 401'd (proves
 * the token is dead and refresh failed). The connector's refresh-on-401
 * logic also fires here, so a verify call against a near-expired token
 * silently rotates it.
 *
 * Auth: settings.manage_team.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { buildRestConnectorForWorkspace } from "@/lib/assistant/connectors";
import { loadConnectorCredentials } from "@/lib/assistant/connectors/credentials";
import {
  establishSession,
  establishOAuthPasswordSession,
  establishNextAuthSession,
} from "@/lib/platform-scan/session";
import { trackEvent } from "@/lib/analytics";

/**
 * Verify a form-login (username_password) or OAuth-password connector by
 * performing the ACTUAL login the scanner would, not a REST search. A bearer
 * search probe sends the stored credential as a header to a form-login app,
 * which returns its HTML page (non-JSON) and looks like a failure even when the
 * credentials are correct. This mirrors resolveAuth so Verify tells the truth.
 * Returns null for static_bearer / oauth2 so the caller falls through to the
 * REST probe.
 */
async function verifyLoginConnector(
  workspaceId: string,
  connectorName: string,
): Promise<{ ok: boolean; code: string; message: string } | null> {
  const creds = await loadConnectorCredentials(workspaceId, connectorName).catch(() => null);
  if (!creds) return null;
  if (creds.authType === "username_password" && creds.username && creds.password) {
    const session = await establishSession({
      baseUrl: creds.baseUrl,
      loginPath: creds.loginPath ?? "/api/auth/login",
      username: creds.username,
      password: creds.password,
      sessionCookieName: creds.sessionCookieName,
    });
    return session
      ? { ok: true, code: "ok", message: "Form login succeeded; session established." }
      : { ok: false, code: "auth_failed", message: "Form login failed (check username/password, login path, and session cookie name)." };
  }
  if (creds.authType === "nextauth_credentials" && creds.username && creds.password) {
    const session = await establishNextAuthSession({
      baseUrl: creds.baseUrl,
      loginPath: creds.loginPath ?? "/api/auth/callback/credentials",
      username: creds.username,
      password: creds.password,
      sessionCookieName: creds.sessionCookieName,
    });
    return session
      ? { ok: true, code: "ok", message: "NextAuth credentials login succeeded; session established." }
      : { ok: false, code: "auth_failed", message: "NextAuth credentials login failed (check username/password and login path)." };
  }
  if (
    creds.authType === "oauth_password" &&
    creds.clientId && creds.clientSecret && creds.username && creds.password
  ) {
    const session = await establishOAuthPasswordSession({
      baseUrl: creds.baseUrl,
      loginPath: creds.loginPath ?? "/services/oauth2/token",
      clientId: creds.clientId,
      clientSecret: creds.clientSecret,
      username: creds.username,
      password: creds.password,
    });
    return session
      ? { ok: true, code: "ok", message: "OAuth password grant succeeded." }
      : { ok: false, code: "auth_failed", message: "OAuth password grant failed (check client id/secret, username/password, token path)." };
  }
  return null; // static_bearer / oauth2 -> use the REST probe below
}

export async function POST(
  req: NextRequest,
  context: { params: Promise<{ name: string }> },
): Promise<NextResponse> {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const { name } = await context.params;
  const connectorName = typeof name === "string" ? name : "";
  if (!connectorName) {
    return NextResponse.json({ error: "connector name required" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId;
  const t0 = Date.now();

  // Form-login / oauth-password connectors verify by actually logging in.
  const loginResult = await verifyLoginConnector(workspaceId, connectorName);
  if (loginResult) {
    const tookMs = Date.now() - t0;
    trackEvent("assistant.connector_verified", auth.user.id, auth.user.role, {
      connector: connectorName,
      workspace_id: workspaceId,
      ok: loginResult.ok,
      duration_ms: tookMs,
      code: loginResult.code,
    });
    return NextResponse.json(
      { ok: loginResult.ok, code: loginResult.code, message: loginResult.message, duration_ms: tookMs },
      { status: loginResult.ok ? 200 : 401 },
    );
  }

  const connector = await buildRestConnectorForWorkspace(workspaceId, connectorName);
  if (!connector.isConfigured()) {
    return NextResponse.json(
      { ok: false, code: "not_configured", message: "No active credentials for this connector" },
      { status: 404 },
    );
  }

  /* Cheap read — searchRecords with a 2-char query is the lowest-cost
     authenticated call we can issue. Any 2xx (even an empty result set)
     means the auth path works. */
  const probeQuery = "xx";
  const result = await connector.searchRecords("contact", probeQuery, 1);
  const tookMs = Date.now() - t0;

  trackEvent("assistant.connector_verified", auth.user.id, auth.user.role, {
    connector: connectorName,
    workspace_id: workspaceId,
    ok: result.ok,
    duration_ms: tookMs,
    code: result.ok ? "ok" : result.code ?? "unknown",
  });

  if (!result.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: result.code,
        message: result.message ?? "verify_failed",
        duration_ms: tookMs,
      },
      { status: result.code === "auth_failed" ? 401 : 502 },
    );
  }

  return NextResponse.json({
    ok: true,
    matched: (result.data ?? []).length,
    duration_ms: tookMs,
  });
}

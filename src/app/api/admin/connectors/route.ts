/**
 * /api/admin/connectors — CRUD for per-tenant connector credentials.
 *
 *   GET  → list active credentials for the caller's workspace (masked
 *          auth-header hints; plaintext never leaves the server).
 *   POST → upsert credentials for (workspace, connectorName). Body:
 *          static_bearer / oauth2:
 *            { connectorName, baseUrl, authType?, authHeader, objectMap? }
 *          username_password (form-login platforms, e.g. beyond's
 *          POST /api/auth/login):
 *            { connectorName, baseUrl, authType: "username_password",
 *              username, password, loginPath, sessionCookieName?,
 *              objectMap? }
 *          oauth_password (OAuth2 Resource Owner Password, e.g.
 *          Salesforce — baseUrl is the login URL like
 *          https://test.salesforce.com, loginPath the token endpoint):
 *            { connectorName, baseUrl, authType: "oauth_password",
 *              clientId, clientSecret, username, password, loginPath,
 *              objectMap? }
 *          nextauth_credentials (NextAuth.js / Auth.js Credentials provider,
 *          e.g. wolfpack-auto - loginPath defaults to the credentials
 *          callback /api/auth/callback/credentials):
 *            { connectorName, baseUrl, authType: "nextauth_credentials",
 *              username, password, loginPath, sessionCookieName?,
 *              objectMap? }
 *
 * CTO/CEO only (settings.manage_team capability). Audit-log every
 * mutation. The workspaceId is resolved from the caller's session —
 * never accepted from the request body, so a privileged user can't
 * write into another tenant's credential row.
 *
 * The frontend admin UI lives at /admin/settings/connectors (drop-in
 * once the route is live).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  saveConnectorCredentials,
  listConnectorCredentials,
} from "@/lib/assistant/connectors";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";
import { getVendorPreset } from "@/lib/assistant/connectors/vendor-presets";

/** Connectors clients can configure. Wider than just "rest-default" so
 *  the next wave of vendor adapters drops in without an allow-list
 *  change. */
const SUPPORTED_CONNECTORS = new Set([
  "rest-default",
  "hubspot",
  "salesforce",
  "quickbooks",
]);

type AuthType =
  | "static_bearer"
  | "oauth2"
  | "username_password"
  | "oauth_password"
  | "nextauth_credentials";

interface PostBody {
  connectorName?: unknown;
  baseUrl?: unknown;
  authType?: unknown;
  authHeader?: unknown;
  username?: unknown;
  password?: unknown;
  loginPath?: unknown;
  sessionCookieName?: unknown;
  clientId?: unknown;
  clientSecret?: unknown;
  objectMap?: unknown;
}

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  /* Workspace comes from the session, never the request body — a
     privileged user must not be able to read another tenant's
     connector list by spoofing workspace_id in a query string. */
  const workspaceId = auth.user.workspaceId;
  const connectors = await listConnectorCredentials(workspaceId);
  return NextResponse.json({ connectors });
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  let body: PostBody | null;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body" }, { status: 400 });
  }

  /* --- Validate --- */
  const connectorName = typeof body.connectorName === "string" ? body.connectorName.trim() : "";
  // auth_type defaults to static_bearer so existing vendor callers keep working.
  const rawAuthType = body.authType === undefined ? "static_bearer" : body.authType;
  if (
    rawAuthType !== "static_bearer" &&
    rawAuthType !== "oauth2" &&
    rawAuthType !== "username_password" &&
    rawAuthType !== "oauth_password" &&
    rawAuthType !== "nextauth_credentials"
  ) {
    return NextResponse.json(
      {
        error:
          "authType must be one of: static_bearer, oauth2, username_password, oauth_password, nextauth_credentials",
      },
      { status: 400 },
    );
  }
  // Vendor (bearer/oauth2) connectors must be a known preset name. A
  // username_password / oauth_password connection targets an ARBITRARY client
  // platform, so any url-safe slug is allowed (this is what lets an operator
  // connect a client system an agent was invited to, not just our preset
  // vendors).
  if (
    rawAuthType === "username_password" ||
    rawAuthType === "oauth_password" ||
    rawAuthType === "nextauth_credentials"
  ) {
    if (!/^[a-z0-9][a-z0-9-]{1,48}$/.test(connectorName)) {
      return NextResponse.json(
        { error: "connectorName must be a url-safe slug (a-z, 0-9, dash; 2-49 chars)" },
        { status: 400 },
      );
    }
  } else if (!SUPPORTED_CONNECTORS.has(connectorName)) {
    return NextResponse.json(
      { error: `connectorName must be one of: ${[...SUPPORTED_CONNECTORS].join(", ")}` },
      { status: 400 },
    );
  }

  /* Vendor presets: if the caller picks a known vendor and OMITS
     baseUrl / objectMap, fill from the preset. Caller overrides win. */
  const preset = getVendorPreset(connectorName);
  let baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim() : "";
  if (!baseUrl && preset && preset.baseUrl) {
    baseUrl = preset.baseUrl;
  }
  if (!/^https?:\/\/[a-zA-Z0-9.\-_]+(:\d+)?(\/.*)?$/.test(baseUrl)) {
    return NextResponse.json(
      {
        error:
          "baseUrl must be http(s) URL" +
          (preset && !preset.baseUrl ? " (this vendor preset requires per-org override)" : ""),
      },
      { status: 400 },
    );
  }
  // (authType already validated above, before the connectorName gate.)
  const authType: AuthType = rawAuthType;

  /* --- Per-auth-type field validation --- */
  let authHeader = "";
  let username: string | undefined;
  let password: string | undefined;
  let loginPath: string | undefined;
  let sessionCookieName: string | undefined;
  let clientId: string | undefined;
  let clientSecret: string | undefined;

  if (authType === "oauth_password") {
    /* OAuth2 Resource Owner Password (Salesforce-style): needs the full
       credential quad + the token-endpoint path. */
    clientId = typeof body.clientId === "string" ? body.clientId.trim() : "";
    clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
    username = typeof body.username === "string" ? body.username : "";
    password = typeof body.password === "string" ? body.password : "";
    loginPath = typeof body.loginPath === "string" ? body.loginPath.trim() : "";
    if (!clientId || !clientSecret || !username || !password || !loginPath) {
      return NextResponse.json(
        {
          error:
            "oauth_password requires clientId, clientSecret, username, password, and loginPath",
        },
        { status: 400 },
      );
    }
    if (!loginPath.startsWith("/")) {
      return NextResponse.json(
        { error: "loginPath must be a path starting with '/'" },
        { status: 400 },
      );
    }
  } else if (
    authType === "username_password" ||
    authType === "nextauth_credentials"
  ) {
    /* Form-login flows (a simple JSON login for username_password, the
       CSRF + credentials-callback flow for nextauth_credentials) take the
       same stored fields: username + password + loginPath (+ optional
       session cookie name). Only the login FLOW the scanner replays differs. */
    username = typeof body.username === "string" ? body.username : "";
    password = typeof body.password === "string" ? body.password : "";
    loginPath = typeof body.loginPath === "string" ? body.loginPath.trim() : "";
    if (!username || !password || !loginPath) {
      return NextResponse.json(
        {
          error: `${authType} requires username, password, and loginPath`,
        },
        { status: 400 },
      );
    }
    if (!loginPath.startsWith("/")) {
      return NextResponse.json(
        { error: "loginPath must be a path starting with '/'" },
        { status: 400 },
      );
    }
    if (
      body.sessionCookieName !== undefined &&
      body.sessionCookieName !== null
    ) {
      if (typeof body.sessionCookieName !== "string") {
        return NextResponse.json(
          { error: "sessionCookieName must be a string" },
          { status: 400 },
        );
      }
      sessionCookieName = body.sessionCookieName.trim() || undefined;
    }
  } else {
    /* static_bearer / oauth2: authHeader required, as before. */
    authHeader = typeof body.authHeader === "string" ? body.authHeader : "";
    if (authHeader.length < 4 || authHeader.length > 4096) {
      return NextResponse.json(
        { error: "authHeader must be 4–4096 chars" },
        { status: 400 },
      );
    }
  }

  let objectMap: Record<string, string> | undefined;
  if (body.objectMap !== undefined && body.objectMap !== null) {
    if (typeof body.objectMap !== "object" || Array.isArray(body.objectMap)) {
      return NextResponse.json(
        { error: "objectMap must be an object" },
        { status: 400 },
      );
    }
    const entries = Object.entries(body.objectMap as Record<string, unknown>);
    if (entries.some(([, v]) => typeof v !== "string")) {
      return NextResponse.json(
        { error: "objectMap values must be strings" },
        { status: 400 },
      );
    }
    objectMap = body.objectMap as Record<string, string>;
  }
  if (!objectMap && preset) {
    objectMap = { ...preset.objectMap };
  }

  /* Workspace resolved server-side, not from body — a privileged
     user must not be able to write into another tenant's row. */
  const workspaceId = auth.user.workspaceId;

  const saved = await saveConnectorCredentials({
    workspaceId,
    connectorName,
    baseUrl,
    authType,
    /* authHeader only carries a value for static_bearer / oauth2. For
       username_password the lib derives the Basic header from
       username + password; for oauth_password it stores an encrypted JSON
       blob of the clientId/clientSecret/username/password quad. */
    ...(authType === "oauth_password"
      ? { clientId, clientSecret, username, password, loginPath }
      : authType === "username_password" || authType === "nextauth_credentials"
        ? { username, password, loginPath, sessionCookieName }
        : { authHeader }),
    objectMap,
    createdBy: user.id,
  });

  if (!saved) {
    return NextResponse.json(
      { error: "Failed to save credentials (shadow mode or DB error)" },
      { status: 500 },
    );
  }

  const meta = extractRequestMetadata(req);
  await recordAudit({
    actor: { user_id: user.id, role: user.role },
    action: "connector.credentials.updated",
    resourceType: "connector_credentials",
    resourceId: `${workspaceId}:${connectorName}`,
    afterState: {
      workspace_id: workspaceId,
      connector_name: connectorName,
      base_url: baseUrl,
      auth_type: authType,
      auth_header_hint: saved.authHeaderHint,
      has_object_map: Boolean(objectMap),
      /* Never audit secrets (password / clientSecret) — only the
         (non-secret) auth-endpoint path (+ cookie name for form login) so
         an operator can see how the connector auths. */
      ...(authType === "username_password" || authType === "nextauth_credentials"
        ? { login_path: loginPath, session_cookie_name: sessionCookieName ?? null }
        : authType === "oauth_password"
          ? { login_path: loginPath }
          : {}),
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ connector: saved });
}

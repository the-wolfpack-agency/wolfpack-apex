/**
 * /api/admin/connectors — CRUD for per-tenant connector credentials.
 *
 *   GET  → list active credentials for the caller's workspace (masked
 *          auth-header hints; plaintext never leaves the server).
 *   POST → upsert credentials for (workspace, connectorName). Body:
 *          { connectorName, baseUrl, authHeader, objectMap? }
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

interface PostBody {
  connectorName?: unknown;
  baseUrl?: unknown;
  authHeader?: unknown;
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
  const connectorName = typeof body.connectorName === "string" ? body.connectorName : "";
  if (!SUPPORTED_CONNECTORS.has(connectorName)) {
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

  const authHeader = typeof body.authHeader === "string" ? body.authHeader : "";
  if (authHeader.length < 4 || authHeader.length > 4096) {
    return NextResponse.json(
      { error: "authHeader must be 4–4096 chars" },
      { status: 400 },
    );
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
    authHeader,
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
      auth_header_hint: saved.authHeaderHint,
      has_object_map: Boolean(objectMap),
    },
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    requestId: meta.requestId,
  }).catch((e) => console.warn("[audit]", (e as Error).message));

  return NextResponse.json({ connector: saved });
}

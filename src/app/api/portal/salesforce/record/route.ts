/**
 * /api/portal/salesforce/record
 *
 *   GET   ?type=&id=            → connector.getRecord(...) → typed JSON
 *   PATCH { type, id, field, value } → connector.updateRecord(... single field)
 *   POST  { type, fields }      → connector.createRecord(... full record)
 *
 * Auth contract:
 *   GET    → `settings.manage_team` (read)
 *   PATCH  → `settings.manage_team` (write — single capability for the MVP
 *           since the surface is owner-grade)
 *   POST   → `settings.manage_team` (write)
 *
 * Single-field update mirrors update_external_record-tool.ts so the
 * portal can't run a multi-field PATCH the chat path doesn't allow.
 * That keeps the audit story consistent — every Salesforce mutation
 * went through one of two doors (chat with confirmation, or portal
 * with explicit save).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  resolveSalesforceConnector,
  connectorErrorToHttp,
  isPortalType,
  portalTypeToObject,
} from "../_helpers";

interface RecordGetResponse {
  notConfigured: boolean;
  record: Record<string, unknown>;
  instanceUrl: string | null;
  connector: string;
}

interface RecordWriteResponse {
  ok: true;
  id: string;
  connector: string;
}

interface PatchBody {
  type?: unknown;
  id?: unknown;
  field?: unknown;
  value?: unknown;
}

interface PostBody {
  type?: unknown;
  fields?: unknown;
}

const ALLOWED_PATCH_FIELDS = new Set([
  "Name",
  "FirstName",
  "LastName",
  "Email",
  "Phone",
  "Title",
  "Description",
  "Amount",
  "StageName",
  "CloseDate",
  "Industry",
  "Website",
  "Status",
  "AccountId",
  "OwnerId",
]);

export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  const url = new URL(req.url);
  const type = url.searchParams.get("type");
  const id = url.searchParams.get("id");
  if (!isPortalType(type)) {
    return NextResponse.json(
      { error: "type must be contacts | opportunities | accounts", code: "validation" },
      { status: 400 },
    );
  }
  if (!id || id.length < 3 || id.length > 120) {
    return NextResponse.json(
      { error: "id required", code: "validation" },
      { status: 400 },
    );
  }

  const workspaceId = auth.user.workspaceId;
  const resolved = await resolveSalesforceConnector(workspaceId);
  if (resolved.notConfigured) {
    return NextResponse.json({
      notConfigured: true,
      record: {},
      instanceUrl: null,
      connector: resolved.connectorName,
    } satisfies RecordGetResponse);
  }

  const objectType = portalTypeToObject(type);
  const result = await resolved.connector.getRecord(objectType, id);
  if (!result.ok) {
    const mapped = connectorErrorToHttp(result.code);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  trackEvent("portal.salesforce_record_viewed", auth.user.id, auth.user.role, {
    type,
    connector: resolved.connectorName,
  });

  return NextResponse.json({
    notConfigured: false,
    record: (result.data ?? {}) as Record<string, unknown>,
    instanceUrl: resolved.instanceUrl,
    connector: resolved.connectorName,
  } satisfies RecordGetResponse);
}

export async function PATCH(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: PatchBody | null = null;
  try {
    body = (await req.json()) as PatchBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body", code: "validation" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body", code: "validation" }, { status: 400 });
  }

  if (!isPortalType(body.type)) {
    return NextResponse.json({ error: "type must be contacts | opportunities | accounts", code: "validation" }, { status: 400 });
  }
  const id = typeof body.id === "string" ? body.id : "";
  if (id.length < 3 || id.length > 120) {
    return NextResponse.json({ error: "id required", code: "validation" }, { status: 400 });
  }
  const field = typeof body.field === "string" ? body.field : "";
  if (!ALLOWED_PATCH_FIELDS.has(field)) {
    return NextResponse.json(
      { error: `field must be one of: ${Array.from(ALLOWED_PATCH_FIELDS).join(", ")}`, code: "validation" },
      { status: 400 },
    );
  }
  const rawValue = body.value;
  if (
    rawValue !== null &&
    typeof rawValue !== "string" &&
    typeof rawValue !== "number" &&
    typeof rawValue !== "boolean"
  ) {
    return NextResponse.json({ error: "value must be string|number|boolean|null", code: "validation" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId;
  const resolved = await resolveSalesforceConnector(workspaceId);
  if (resolved.notConfigured) {
    return NextResponse.json(
      { error: "Salesforce connector not configured", code: "not_configured" },
      { status: 412 },
    );
  }

  const objectType = portalTypeToObject(body.type);
  const result = await resolved.connector.updateRecord(objectType, id, { [field]: rawValue });
  if (!result.ok) {
    const mapped = connectorErrorToHttp(result.code);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  trackEvent("portal.salesforce_record_updated", auth.user.id, auth.user.role, {
    type: body.type,
    field,
    connector: resolved.connectorName,
  });

  return NextResponse.json({
    ok: true,
    id: result.data?.id ?? id,
    connector: resolved.connectorName,
  } satisfies RecordWriteResponse);
}

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "settings.manage_team");
  if (!auth.ok) return auth.response;

  let body: PostBody | null = null;
  try {
    body = (await req.json()) as PostBody;
  } catch {
    return NextResponse.json({ error: "invalid JSON body", code: "validation" }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "invalid body", code: "validation" }, { status: 400 });
  }
  if (!isPortalType(body.type)) {
    return NextResponse.json({ error: "type must be contacts | opportunities | accounts", code: "validation" }, { status: 400 });
  }
  const rawFields = body.fields;
  if (!rawFields || typeof rawFields !== "object" || Array.isArray(rawFields)) {
    return NextResponse.json({ error: "fields must be an object", code: "validation" }, { status: 400 });
  }
  /* Allow-list each field; same set the PATCH uses so create + update
     stay symmetric and the audit trail is consistent. */
  const fields: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rawFields as Record<string, unknown>)) {
    if (!ALLOWED_PATCH_FIELDS.has(k)) {
      return NextResponse.json(
        { error: `unknown field "${k}"; allowed: ${Array.from(ALLOWED_PATCH_FIELDS).join(", ")}`, code: "validation" },
        { status: 400 },
      );
    }
    if (
      v !== null &&
      typeof v !== "string" &&
      typeof v !== "number" &&
      typeof v !== "boolean"
    ) {
      return NextResponse.json(
        { error: `field "${k}" must be string|number|boolean|null`, code: "validation" },
        { status: 400 },
      );
    }
    fields[k] = v;
  }
  if (Object.keys(fields).length === 0) {
    return NextResponse.json({ error: "at least one field required", code: "validation" }, { status: 400 });
  }

  const workspaceId = auth.user.workspaceId;
  const resolved = await resolveSalesforceConnector(workspaceId);
  if (resolved.notConfigured) {
    return NextResponse.json(
      { error: "Salesforce connector not configured", code: "not_configured" },
      { status: 412 },
    );
  }

  const objectType = portalTypeToObject(body.type);
  const result = await resolved.connector.createRecord(objectType, fields);
  if (!result.ok) {
    const mapped = connectorErrorToHttp(result.code);
    return NextResponse.json(mapped.body, { status: mapped.status });
  }

  trackEvent("portal.salesforce_record_created", auth.user.id, auth.user.role, {
    type: body.type,
    connector: resolved.connectorName,
  });

  return NextResponse.json({
    ok: true,
    id: result.data?.id ?? "",
    connector: resolved.connectorName,
  } satisfies RecordWriteResponse);
}

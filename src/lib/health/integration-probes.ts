/**
 * Integration health probes — connectivity + schema-drift detection
 * for every external service we integrate with.
 *
 * Three layers:
 *   - probeConnectivity(vendor, ctx): one read call confirms the
 *     OAuth handshake still works. Cheap; runs nightly per workspace.
 *   - probeSchema(vendor, objectType, ctx): describe/metadata call,
 *     hashed for drift detection against the last-known-good schema.
 *   - probeAction: stub for the weekly sandbox write probe — surface
 *     wired in this file, sandbox-call lib lands separately so the
 *     nightly path doesn't carry write risk.
 *
 * Every probe persists to instinct_integration_health (table from
 * migration 140) so AgenticQA's orchestrator can read the latest
 * row per (workspace, vendor, kind) and surface drift on its
 * dashboard.
 */

import { createHash } from "node:crypto";
import { safeQuery } from "@/lib/db";
import { trackEvent } from "@/lib/analytics";
import { getConnectionStatus as getMsStatus, graphFetch, getValidToken } from "@/lib/microsoft-graph";
import { getConnectionStatus as getQboStatus } from "@/lib/quickbooks";
import { loadConnectorCredentials } from "@/lib/assistant/connectors/credentials";
import { refreshConnectorAccessToken } from "@/lib/assistant/connectors/oauth/refresh";

export type ProbeKind = "connectivity" | "schema" | "action";

export interface ProbeResult {
  vendor: string;
  probeKind: ProbeKind;
  objectType?: string;
  ok: boolean;
  statusCode?: number;
  schemaHash?: string;
  schemaPayload?: unknown;
  errorMessage?: string;
  durationMs: number;
  /** When true, the vendor isn't configured for this workspace
   *  (no credentials, no token, never connected). Distinct from
   *  `ok=false` with an error — those mean "should work but
   *  doesn't" and warrant an alert. `notConfigured=true` is
   *  expected state for vendors the user hasn't set up; the
   *  orchestrator suppresses these from regression alerts. */
  notConfigured?: boolean;
}

export interface ProbeContext {
  /** Workspace whose credentials we'll use. */
  workspaceId: string;
  /** A user id that has the vendor connected. For MS Graph this is
   *  the only way to pick up a delegated token; for CRM connectors
   *  the workspace creds are tenant-scoped so userId is optional. */
  userId?: string;
}

/* ---------------------------------------------------------------------
 * Schema-hash helpers — normalize then sha256 so cosmetic ordering
 * changes don't trigger false drift alerts.
 * ------------------------------------------------------------------- */

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(",")}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
    .join(",")}}`;
}

export function hashSchema(payload: unknown): string {
  return createHash("sha256").update(stableStringify(payload)).digest("hex");
}

/* ---------------------------------------------------------------------
 * Microsoft Graph — connectivity + schema for the surfaces we depend
 * on (Tasks lists, Calendar events, Mail messages).
 * ------------------------------------------------------------------- */

async function probeMicrosoftConnectivity(ctx: ProbeContext): Promise<ProbeResult> {
  const started = Date.now();
  if (!ctx.userId) {
    return {
      vendor: "microsoft",
      probeKind: "connectivity",
      ok: false,
      errorMessage: "userId required for Microsoft Graph probe",
      durationMs: Date.now() - started,
    };
  }
  try {
    const status = await getMsStatus(ctx.userId);
    return {
      vendor: "microsoft",
      probeKind: "connectivity",
      ok: status.connected,
      errorMessage: status.connected ? undefined : "Not connected",
      /* "Not connected" = no token exists for this user; treat as
       * unconfigured rather than broken so the alert stays quiet. */
      notConfigured: !status.connected,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      vendor: "microsoft",
      probeKind: "connectivity",
      ok: false,
      errorMessage: (err as Error).message.slice(0, 200),
      durationMs: Date.now() - started,
    };
  }
}

const MS_GRAPH_SCHEMA_ENDPOINTS: Record<string, string> = {
  /* These are NOT $metadata (Graph's CSDL is huge). Instead we hit a
   * tiny read with `$top=1` and hash the column set the response
   * actually exposes. If Graph ships a new required field on Task
   * the response shape changes and the hash diffs. */
  task: "me/todo/lists?$top=1",
  event: "me/calendarView?startDateTime=2026-01-01T00:00:00Z&endDateTime=2026-01-02T00:00:00Z&$top=1",
  message: "me/messages?$top=1&$select=id,subject,from,toRecipients",
};

/**
 * Probe SharePoint search itself, because that is what actually broke.
 *
 * WHY IT IS NOT A SCHEMA PROBE. The others hash the field set from a GET with
 * $top=1. SharePoint search is a POST to /search/query, and its failure mode
 * was never a changed field set: it was a 401 on every call for four months,
 * because the request asked for entity types the granted scopes could not
 * cover. A probe that only watched field names would have sat green through
 * all of it.
 *
 * So this runs the real search path with a harmless query and records whether
 * Microsoft answered. Hits are not required and not asserted: a tenant may
 * genuinely hold nothing matching, and demanding results would make the probe
 * fail for a reason that is not a fault. What is recorded is whether the call
 * was SERVED, which is exactly the thing that was false since May.
 */
async function probeSharePointSearch(ctx: ProbeContext): Promise<ProbeResult> {
  const started = Date.now();
  if (!ctx.userId) {
    return {
      vendor: "microsoft",
      probeKind: "schema",
      objectType: "sharepoint",
      ok: false,
      errorMessage: "userId required",
      durationMs: Date.now() - started,
    };
  }
  try {
    const token = await getValidToken(ctx.userId);
    if (!token?.accessToken) {
      return {
        vendor: "microsoft",
        probeKind: "schema",
        objectType: "sharepoint",
        ok: false,
        errorMessage: "No valid token",
        notConfigured: true,
        durationMs: Date.now() - started,
      };
    }
    const { searchSharePoint } = await import("@/lib/integrations/microsoft-sharepoint");
    const res = await searchSharePoint(token.accessToken, { query: "report", topN: 1 });
    if (!res.ok) {
      return {
        vendor: "microsoft",
        probeKind: "schema",
        objectType: "sharepoint",
        ok: false,
        errorMessage: res.code,
        /* A missing scope is a real, actionable fault and must alert. It is the
           precise condition that hid for four months, so it is emphatically
           NOT "not configured". */
        notConfigured: res.code === "not_connected",
        durationMs: Date.now() - started,
      };
    }
    return {
      vendor: "microsoft",
      probeKind: "schema",
      objectType: "sharepoint",
      ok: true,
      /* Hash the shape, not the contents: a hit count changes constantly and
         would report drift every night. */
      schemaHash: hashSchema({ served: true }),
      schemaPayload: { hits: res.value.hits.length, query_sent: res.value.query_string_sent },
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      vendor: "microsoft",
      probeKind: "schema",
      objectType: "sharepoint",
      ok: false,
      errorMessage: (err as Error).message?.slice(0, 200) ?? "probe failed",
      durationMs: Date.now() - started,
    };
  }
}

async function probeMicrosoftSchema(
  objectType: string,
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const started = Date.now();
  const endpoint = MS_GRAPH_SCHEMA_ENDPOINTS[objectType];
  if (!endpoint) {
    return {
      vendor: "microsoft",
      probeKind: "schema",
      objectType,
      ok: false,
      errorMessage: `Unknown Graph object: ${objectType}`,
      durationMs: Date.now() - started,
    };
  }
  if (!ctx.userId) {
    return {
      vendor: "microsoft",
      probeKind: "schema",
      objectType,
      ok: false,
      errorMessage: "userId required",
      durationMs: Date.now() - started,
    };
  }
  try {
    const token = await getValidToken(ctx.userId);
    if (!token) {
      return {
        vendor: "microsoft",
        probeKind: "schema",
        objectType,
        ok: false,
        errorMessage: "No valid token",
        durationMs: Date.now() - started,
      };
    }
    const payload = await graphFetch<{ value?: Array<Record<string, unknown>> }>(
      endpoint,
      token.accessToken,
      ctx.userId,
    );
    /* Normalize: hash on the FIELD NAMES of the first row + the
     * response envelope keys. Values change every poll; field set
     * doesn't unless Graph itself shipped a change. */
    const firstRow = payload?.value?.[0] ?? {};
    const fieldSet = Object.keys(firstRow).sort();
    const schemaHash = hashSchema({ fields: fieldSet });
    return {
      vendor: "microsoft",
      probeKind: "schema",
      objectType,
      ok: true,
      schemaHash,
      schemaPayload: { fields: fieldSet },
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      vendor: "microsoft",
      probeKind: "schema",
      objectType,
      ok: false,
      errorMessage: (err as Error).message.slice(0, 200),
      durationMs: Date.now() - started,
    };
  }
}

/* ---------------------------------------------------------------------
 * QuickBooks — connectivity only for v1; QBO's describe is invoice-
 * heavy and not relevant to the chat widget surface yet.
 * ------------------------------------------------------------------- */

async function probeQuickbooksConnectivity(_ctx: ProbeContext): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const status = await getQboStatus();
    return {
      vendor: "quickbooks",
      probeKind: "connectivity",
      ok: status.connected,
      errorMessage: status.connected ? undefined : "Not connected",
      notConfigured: !status.connected,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      vendor: "quickbooks",
      probeKind: "connectivity",
      ok: false,
      errorMessage: (err as Error).message.slice(0, 200),
      durationMs: Date.now() - started,
    };
  }
}

/* ---------------------------------------------------------------------
 * CRM connectors (Salesforce, HubSpot) — the generic rest-connector
 * framework. Connectivity = "credentials loaded + base URL set".
 * Schema = call the vendor's describe endpoint when known, hash the
 * field set. AgenticQA's orchestrator reads the hash to detect drift.
 * ------------------------------------------------------------------- */

const CRM_CONNECTORS = ["salesforce", "hubspot"] as const;
type CrmConnector = (typeof CRM_CONNECTORS)[number];

/* Vendor-specific describe endpoints. Object names align with our
 * form-tool's vocabulary so the connectivity layer maps 1:1 to what
 * the widgets read. */
const CRM_SCHEMA_PATHS: Record<CrmConnector, Record<string, string>> = {
  salesforce: {
    deal: "/services/data/v59.0/sobjects/Opportunity/describe",
    contact: "/services/data/v59.0/sobjects/Contact/describe",
    account: "/services/data/v59.0/sobjects/Account/describe",
    task: "/services/data/v59.0/sobjects/Task/describe",
  },
  hubspot: {
    deal: "/crm/v3/properties/deals",
    contact: "/crm/v3/properties/contacts",
    account: "/crm/v3/properties/companies",
    task: "/crm/v3/properties/tasks",
  },
};

/**
 * Load credentials + proactively refresh the OAuth access token if
 * it's near expiry. Returns null when the connector isn't configured
 * (so callers can flag notConfigured=true). Returns the credential
 * record with a freshly-rotated authHeader when refresh succeeds, or
 * the existing record on refresh failure (and the probe will see the
 * vendor's 401 — that's the regression we want to alert on).
 *
 * Without this step, raw fetch() probes hit the vendor with a stale
 * token and get 401 — which surfaced as the Salesforce regression on
 * 2026-05-18. The rest-connector calls refresh REACTIVELY on 401, but
 * probes don't go through rest-connector.
 */
async function loadFreshCrmCreds(
  vendor: CrmConnector,
  workspaceId: string,
): Promise<{ baseUrl: string; authHeader: string } | null> {
  const creds = await loadConnectorCredentials(workspaceId, vendor);
  if (!creds || !creds.isActive) return null;
  /* If OAuth + near expiry, proactively refresh. The refresh layer
   * is a no-op for static-bearer connectors so this is safe to call
   * unconditionally. */
  try {
    const refreshed = await refreshConnectorAccessToken({
      workspaceId,
      connectorName: vendor,
    });
    if (refreshed && refreshed.authHeader) {
      return { baseUrl: refreshed.baseUrl, authHeader: refreshed.authHeader };
    }
  } catch {
    /* refresh failed — fall through with existing creds and let the
     * vendor's 401 surface as the regression. */
  }
  return { baseUrl: creds.baseUrl, authHeader: creds.authHeader };
}

async function probeCrmConnectivity(
  vendor: CrmConnector,
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const started = Date.now();
  try {
    const creds = await loadFreshCrmCreds(vendor, ctx.workspaceId);
    if (!creds) {
      return {
        vendor,
        probeKind: "connectivity",
        ok: false,
        errorMessage: "No active credentials for this workspace",
        notConfigured: true,
        durationMs: Date.now() - started,
      };
    }
    /* Probe the vendor's lightest read. Salesforce has /sobjects (lists
     * available objects); HubSpot has /crm/v3/objects/companies?limit=1. */
    const path = vendor === "salesforce"
      ? "/services/data/v59.0/sobjects"
      : "/crm/v3/objects/companies?limit=1";
    const res = await fetch(`${creds.baseUrl}${path}`, {
      headers: { Authorization: creds.authHeader, Accept: "application/json" },
    });
    const ok = res.status >= 200 && res.status < 300;
    return {
      vendor,
      probeKind: "connectivity",
      ok,
      statusCode: res.status,
      errorMessage: ok ? undefined : `HTTP ${res.status}`,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      vendor,
      probeKind: "connectivity",
      ok: false,
      errorMessage: (err as Error).message.slice(0, 200),
      durationMs: Date.now() - started,
    };
  }
}

async function probeCrmSchema(
  vendor: CrmConnector,
  objectType: string,
  ctx: ProbeContext,
): Promise<ProbeResult> {
  const started = Date.now();
  const path = CRM_SCHEMA_PATHS[vendor]?.[objectType];
  if (!path) {
    return {
      vendor,
      probeKind: "schema",
      objectType,
      ok: false,
      errorMessage: `No schema endpoint mapped for ${vendor}/${objectType}`,
      durationMs: Date.now() - started,
    };
  }
  try {
    const creds = await loadFreshCrmCreds(vendor, ctx.workspaceId);
    if (!creds) {
      return {
        vendor,
        probeKind: "schema",
        objectType,
        ok: false,
        errorMessage: "No active credentials for this workspace",
        notConfigured: true,
        durationMs: Date.now() - started,
      };
    }
    const res = await fetch(`${creds.baseUrl}${path}`, {
      headers: { Authorization: creds.authHeader, Accept: "application/json" },
    });
    if (res.status < 200 || res.status >= 300) {
      return {
        vendor,
        probeKind: "schema",
        objectType,
        ok: false,
        statusCode: res.status,
        errorMessage: `HTTP ${res.status}`,
        durationMs: Date.now() - started,
      };
    }
    const payload = (await res.json()) as Record<string, unknown>;
    /* Normalize: hash the FIELD NAMES + their type + required flag.
     * Don't hash values like `defaultValue` or `label` that change
     * cosmetically and would cause noisy drift alerts. */
    const fields = extractCrmFields(vendor, payload);
    const schemaHash = hashSchema(fields);
    return {
      vendor,
      probeKind: "schema",
      objectType,
      ok: true,
      statusCode: res.status,
      schemaHash,
      schemaPayload: fields,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    return {
      vendor,
      probeKind: "schema",
      objectType,
      ok: false,
      errorMessage: (err as Error).message.slice(0, 200),
      durationMs: Date.now() - started,
    };
  }
}

interface NormalizedField {
  name: string;
  type: string;
  required: boolean;
}

function extractCrmFields(
  vendor: CrmConnector,
  payload: Record<string, unknown>,
): NormalizedField[] {
  if (vendor === "salesforce") {
    const fields = Array.isArray(payload.fields) ? payload.fields : [];
    return fields
      .map((f) => {
        const raw = f as Record<string, unknown>;
        return {
          name: String(raw.name ?? ""),
          type: String(raw.type ?? ""),
          /* Salesforce: required = !nillable && !defaultedOnCreate
           * is the most-accurate "must include on POST" predicate. */
          required: raw.nillable === false && raw.defaultedOnCreate === false,
        };
      })
      .filter((f) => f.name)
      .sort((a, b) => a.name.localeCompare(b.name));
  }
  /* HubSpot: properties endpoint returns { results: [{ name, type, ... }] }.
   * `required` isn't on the property itself; HubSpot enforces required
   * at the create-form layer. For drift detection the (name, type)
   * pair is enough — required will be added by the form-mirror work. */
  const results = Array.isArray((payload as { results?: unknown[] }).results)
    ? (payload as { results: unknown[] }).results
    : [];
  return results
    .map((r) => {
      const raw = r as Record<string, unknown>;
      return {
        name: String(raw.name ?? ""),
        type: String(raw.type ?? ""),
        required: false,
      };
    })
    .filter((f) => f.name)
    .sort((a, b) => a.name.localeCompare(b.name));
}

/* ---------------------------------------------------------------------
 * Public surface: dispatch by vendor.
 * ------------------------------------------------------------------- */

export async function runProbe(
  vendor: string,
  probeKind: ProbeKind,
  ctx: ProbeContext,
  objectType?: string,
): Promise<ProbeResult> {
  if (probeKind === "action") {
    return {
      vendor,
      probeKind,
      objectType,
      ok: false,
      errorMessage: "Action probes are weekly + sandbox-only (not wired here yet)",
      durationMs: 0,
    };
  }

  if (vendor === "microsoft") {
    return probeKind === "connectivity"
      ? probeMicrosoftConnectivity(ctx)
      : objectType === "sharepoint"
        ? probeSharePointSearch(ctx)
        : probeMicrosoftSchema(objectType ?? "task", ctx);
  }
  if (vendor === "quickbooks") {
    return probeQuickbooksConnectivity(ctx);
  }
  if (vendor === "salesforce" || vendor === "hubspot") {
    return probeKind === "connectivity"
      ? probeCrmConnectivity(vendor, ctx)
      : probeCrmSchema(vendor, objectType ?? "deal", ctx);
  }
  return {
    vendor,
    probeKind,
    objectType,
    ok: false,
    errorMessage: `Unknown vendor: ${vendor}`,
    durationMs: 0,
  };
}

/* ---------------------------------------------------------------------
 * Persistence.
 * ------------------------------------------------------------------- */

export async function persistProbeResult(
  workspaceId: string,
  result: ProbeResult,
): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    /* Truncate the JSON payload so a runaway schema response doesn't
     * blow up the table. 16KB is plenty for normalized field lists. */
    const payload = result.schemaPayload
      ? JSON.stringify(result.schemaPayload).slice(0, 16 * 1024)
      : null;
    await safeQuery(
      `INSERT INTO integration_health
         (workspace_id, vendor, probe_kind, object_type, ok, status_code,
          schema_hash, schema_payload, error_message, duration_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10)`,
      [
        workspaceId,
        result.vendor,
        result.probeKind,
        result.objectType ?? null,
        result.ok,
        result.statusCode ?? null,
        result.schemaHash ?? null,
        payload,
        result.errorMessage ?? null,
        result.durationMs,
      ],
    );
  } catch (err) {
    console.warn("[integration-probes] persist failed:", (err as Error).message);
  }
}

/* ---------------------------------------------------------------------
 * Last-known-good lookup. AgenticQA's orchestrator calls this then
 * diffs the latest schema_hash against it — if they don't match, the
 * vendor's schema changed since the last probe.
 * ------------------------------------------------------------------- */

export async function getLastKnownGoodHash(
  workspaceId: string,
  vendor: string,
  objectType: string,
): Promise<string | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const r = await safeQuery<{ schema_hash: string }>(
      `SELECT schema_hash
         FROM integration_health
        WHERE workspace_id = $1
          AND vendor = $2
          AND probe_kind = 'schema'
          AND object_type = $3
          AND ok = true
          AND schema_hash IS NOT NULL
        ORDER BY probed_at DESC
        LIMIT 1`,
      [workspaceId, vendor, objectType],
    );
    return r.rows[0]?.schema_hash ?? null;
  } catch {
    return null;
  }
}

/* The vendors + object types the nightly sweep covers. Mirrors DEFAULT_VENDORS
 * in the read route (consolidate the two when that route is next touched). */
const DEFAULT_PROBE_VENDORS: Array<{ vendor: string; objects: string[]; needsUserId: boolean }> = [
  /* sharepoint joins task/event/message so the nightly sweep exercises the
     search path that returned 401 on every call from 2026-05-06 to 2026-08-28
     without anything noticing. */
  { vendor: "microsoft", objects: ["task", "event", "message", "sharepoint"], needsUserId: true },
  { vendor: "salesforce", objects: ["deal", "contact", "account"], needsUserId: false },
  { vendor: "hubspot", objects: ["deal", "contact", "account"], needsUserId: false },
  { vendor: "quickbooks", objects: [], needsUserId: false },
];

export interface WorkspaceSweepResult { vendors: number; probes: number; drifted: string[] }

/**
 * Probe every configured vendor for ONE workspace: a connectivity probe, then a
 * schema probe per object type (only when connectivity is OK). Each result is
 * persisted. SCHEMA DRIFT is the learning tie-in: when a fresh schema hash
 * differs from the last-known-good for that (vendor, object), we emit
 * integration.schema_drift so the loop sees a vendor field-set change BEFORE it
 * silently breaks a user's workflow. Never throws (probes are best-effort).
 */
export async function sweepWorkspace(workspaceId: string, opts: { userId?: string } = {}): Promise<WorkspaceSweepResult> {
  const drifted: string[] = [];
  let probes = 0;
  for (const v of DEFAULT_PROBE_VENDORS) {
    const ctx: ProbeContext = { workspaceId, userId: v.needsUserId ? opts.userId : undefined };
    const connectivity = await runProbe(v.vendor, "connectivity", ctx);
    await persistProbeResult(workspaceId, connectivity);
    probes++;
    if (connectivity.ok && v.objects.length > 0) {
      const schemaResults = await Promise.all(v.objects.map((o) => runProbe(v.vendor, "schema", ctx, o)));
      for (const sr of schemaResults) {
        // Compare to the last-known-good BEFORE persisting this run's row.
        if (sr.ok && sr.schemaHash && sr.objectType) {
          const last = await getLastKnownGoodHash(workspaceId, v.vendor, sr.objectType);
          if (last && last !== sr.schemaHash) {
            drifted.push(`${v.vendor}.${sr.objectType}`);
            try {
              trackEvent("integration.health_drift_detected", "system", "system", {
                workspace_id: workspaceId, vendor: v.vendor, object_type: sr.objectType,
              });
            } catch { /* analytics is best-effort; the persisted row is the record */ }
          }
        }
        await persistProbeResult(workspaceId, sr);
        probes++;
      }
    }
  }
  return { vendors: DEFAULT_PROBE_VENDORS.length, probes, drifted };
}

/**
 * Nightly orchestrator: sweep every workspace that has at least one active
 * connector. CRM connectors use workspace-scoped creds, so the unattended sweep
 * covers them; per-user vendors (Microsoft) are probed on their own user path.
 */
/**
 * A Microsoft account in this workspace to probe as.
 *
 * WHY THE SWEEP NEEDED THIS. The Microsoft probe requires a userId, because
 * Graph access is delegated: there is no tenant-wide "is it healthy" call, only
 * "can THIS person reach it". sweepAllWorkspaces never passed one, so the probe
 * short-circuited on its own guard every night.
 *
 * Measured 2026-08-28: 157 Microsoft probes recorded, ZERO successful. 94 read
 * "Not connected" and 63 read "userId required for Microsoft Graph probe",
 * the most recent from that morning's cron. A health check that has never once
 * succeeded is not a health check, and this is the monitoring that should have
 * caught SharePoint returning 401 for four months.
 *
 * Picks the most recently refreshed token, because a stale one tells you less:
 * probing as somebody who has not signed in for months would report a problem
 * with that account rather than with the integration.
 */
async function resolveMicrosoftProbeUser(workspaceId: string): Promise<string | undefined> {
  try {
    const { rows } = await safeQuery<{ connected_by: string }>(
      `SELECT t.connected_by
         FROM instinct_ms_tokens t
         JOIN instinct_team_members m ON m.id::text = t.connected_by
        WHERE m.workspace_id = $1
          AND COALESCE(m.is_active, TRUE) = TRUE
        ORDER BY t.updated_at DESC NULLS LAST
        LIMIT 1`,
      [workspaceId],
    );
    return rows[0]?.connected_by ?? undefined;
  } catch {
    /* A probe that cannot pick a user reports "userId required" exactly as
       before. Degrading is right here: the sweep must not fail because one
       lookup did. */
    return undefined;
  }
}

export async function sweepAllWorkspaces(): Promise<{ workspaces: number; probes: number; drifted: string[] }> {
  const { rows } = await safeQuery<{ workspace_id: string }>(
    `SELECT DISTINCT workspace_id FROM instinct_connector_credentials WHERE is_active = true`,
  );
  let probes = 0;
  const drifted: string[] = [];
  for (const r of rows) {
    /* Resolved per workspace rather than passed in, so the nightly cron probes
       Microsoft as a real connected account instead of failing its own guard. */
    const userId = await resolveMicrosoftProbeUser(r.workspace_id);
    const res = await sweepWorkspace(r.workspace_id, userId ? { userId } : {});
    probes += res.probes;
    drifted.push(...res.drifted);
  }
  return { workspaces: rows.length, probes, drifted };
}

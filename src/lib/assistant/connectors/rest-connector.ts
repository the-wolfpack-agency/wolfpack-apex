/**
 * RestConnector — generic REST adapter that points at any client's API.
 *
 * Configuration is env-driven for the Phase-4 first cut:
 *   INSTINCT_REST_CRM_BASE_URL   the API root (e.g. https://api.acme.com/v1)
 *   INSTINCT_REST_CRM_AUTH       the full Authorization header value
 *                                (e.g. "Bearer eyJ..." or "Basic ...")
 *   INSTINCT_REST_CRM_OBJECT_MAP optional JSON object that maps
 *                                domain object types to URL path
 *                                segments. Defaults to identity
 *                                mapping ({contact: "contacts", deal:
 *                                "deals", ...}).
 *
 * Why generic-REST and not HubSpot/Salesforce-specific:
 *   - Phase-4's goal is the framework, not vendor specifics.
 *   - Any client whose CRM exposes a REST API (most do) can be
 *     pointed at on day one.
 *   - Vendor adapters (HubSpot wrapper, Salesforce wrapper) drop in
 *     later as separate connectors that wrap their SDKs.
 *
 * Per-tenant credentials migrate from env to instinct_connector_credentials
 * (encrypted-at-rest) in the next slice — the Connector interface
 * doesn't change.
 */

import type { Connector, ConnectorResult } from "./types";
import { createHash } from "node:crypto";
import { trackEvent } from "@/lib/analytics";
import { registerConnector } from "./registry";
import { loadConnectorCredentials } from "./credentials";
import { refreshConnectorAccessToken } from "./oauth/refresh";
import { getVendorPreset, type VendorPreset } from "./vendor-presets";

const DEFAULT_OBJECT_MAP: Record<string, string> = {
  contact: "contacts",
  deal: "deals",
  company: "companies",
  account: "accounts",
  invoice: "invoices",
  payment: "payments",
  ticket: "tickets",
};

export interface RestConnectorConfig {
  baseUrl?: string;
  authHeader?: string;
  objectMap?: Record<string, string>;
  /** Override for tests so we don't hit the real network. */
  fetchImpl?: typeof fetch;
  /** Override for tests + per-tenant overrides later. */
  name?: string;
  /** When set, the connector hands off to refreshConnectorAccessToken
   *  on a 401, retries once with the refreshed token, and returns the
   *  retry result. Required for OAuth-backed connectors (Salesforce,
   *  HubSpot, future Jira/QBO). Static-bearer connectors leave this
   *  unset and a 401 returns directly. */
  workspaceId?: string;
  /** Test seam — when set, the refresh path uses this fetch instead of
   *  the global one. */
  refreshFetchImpl?: typeof fetch;
  /** Override the vendor preset lookup. Tests pass an in-memory preset
   *  so they don't depend on the registry. Production reads the preset
   *  via `getVendorPreset(name)`. */
  vendorPreset?: VendorPreset | null;
}

/**
 * How long we wait for somebody else's system before giving up.
 *
 * There was no timeout at all, and a server that accepts the connection
 * and never answers made the call hang indefinitely. Mocked fetch
 * cannot show this: it always resolves. A real HTTP server that simply
 * does not reply showed it in eight seconds.
 *
 * It matters most exactly where this product is aimed. A legacy system
 * behind a flaky VPN does not usually refuse a connection, it accepts
 * it and goes quiet, and an assistant chain waiting on it stalls with
 * no error to report. On a serverless function it burns the whole
 * execution budget and the user sees a blank response rather than "that
 * system did not answer".
 */
export const CONNECTOR_TIMEOUT_MS = 15_000;

export class RestConnector implements Connector {
  readonly name: string;
  readonly description = "Generic REST API adapter (configurable per tenant via env).";
  private baseUrl?: string;
  private authHeader?: string;
  private readonly objectMap: Record<string, string>;
  private readonly fetchImpl: typeof fetch;
  private readonly workspaceId?: string;
  private readonly refreshFetchImpl?: typeof fetch;
  private readonly vendorPreset: VendorPreset | null;

  constructor(cfg: RestConnectorConfig = {}) {
    this.name = cfg.name ?? "rest-default";
    this.baseUrl = cfg.baseUrl ?? process.env.INSTINCT_REST_CRM_BASE_URL;
    this.authHeader = cfg.authHeader ?? process.env.INSTINCT_REST_CRM_AUTH;
    this.objectMap = {
      ...DEFAULT_OBJECT_MAP,
      ...(cfg.objectMap ?? parseEnvObjectMap(process.env.INSTINCT_REST_CRM_OBJECT_MAP)),
    };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
    this.workspaceId = cfg.workspaceId;
    this.refreshFetchImpl = cfg.refreshFetchImpl;
    /* Vendor preset drives provider-aware search (Salesforce SOQL,
       HubSpot search). When the connector name matches a known preset
       (salesforce, hubspot, …) we pick that up automatically; tests
       can override via cfg.vendorPreset. */
    this.vendorPreset =
      cfg.vendorPreset !== undefined ? cfg.vendorPreset : getVendorPreset(this.name);
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.authHeader);
  }

  objectTypes(): string[] {
    /* A vendor preset is a statement about what that system actually
       holds. The generic default map adds invoice, payment and account
       to every connector, so before this the overlap analysis reported
       that invoices lived in both HubSpot and Salesforce when neither
       preset maps an invoice endpoint at all. A fabricated overlap is
       worse than a missing one: it is the first thing a client checks. */
    if (this.vendorPreset?.objectMap) return Object.keys(this.vendorPreset.objectMap);
    return Object.keys(this.objectMap);
  }

  async getRecord(
    objectType: string,
    id: string,
  ): Promise<ConnectorResult<Record<string, unknown>>> {
    if (!this.isConfigured()) {
      return notConfigured(this.name, "getRecord");
    }
    const path = this.objectMap[objectType.toLowerCase()] ?? objectType.toLowerCase();
    return this.request<Record<string, unknown>>(
      `/${path}/${encodeURIComponent(id)}`,
      false,
      { operation: "getRecord", objectType: objectType.toLowerCase() },
    );
  }

  async searchRecords(
    objectType: string,
    query: string,
    limit = 10,
  ): Promise<ConnectorResult<Array<Record<string, unknown>>>> {
    if (!this.isConfigured()) {
      return notConfigured(this.name, "searchRecords");
    }
    /* Empty query is the LIST-ALL sentinel: the caller wants the top N
       records of this object type with no name filter ("client list",
       "pull the customer list"). The vendor preset's search.build turns
       an empty query into a no-WHERE list query (Salesforce: SELECT …
       FROM <SObject> LIMIT N; HubSpot: the bare list endpoint). A
       NON-empty query still requires ≥2 chars so a stray single char
       doesn't fan out an accidental list-all. */
    const trimmed = (query ?? "").trim();
    const isListAll = trimmed.length === 0;
    if (!isListAll && trimmed.length < 2) {
      return {
        ok: false,
        code: "validation",
        message: "search query must be at least 2 characters",
      };
    }
    /* Vendor-aware search path. When the preset has a search builder
       (Salesforce SOQL, HubSpot contacts-search), use it AND its
       extractor. Otherwise fall back to the generic
       `${path}?q=${q}&limit=${limit}` shape that suits a handful of
       small REST APIs. */
    if (this.vendorPreset?.search) {
      const req = this.vendorPreset.search.build(objectType.toLowerCase(), trimmed, limit);
      const r = await this.request<unknown>(
        req.path.startsWith("/") ? req.path : `/${req.path}`,
        false,
        { operation: "searchRecords", objectType: objectType.toLowerCase() },
      );
      if (!r.ok) return r as ConnectorResult<Array<Record<string, unknown>>>;
      const records = req.extract(r.data);
      return { ok: true, data: records, durationMs: r.durationMs };
    }

    const path = this.objectMap[objectType.toLowerCase()] ?? objectType.toLowerCase();
    /* List-all (empty query) drops the `q` param entirely so a generic
       REST list endpoint returns the top N rows unfiltered. */
    const url = isListAll
      ? `/${path}?limit=${limit}`
      : `/${path}?q=${encodeURIComponent(trimmed)}&limit=${limit}`;
    const r = await this.request<unknown>(url, false, {
      operation: "searchRecords",
      objectType: objectType.toLowerCase(),
    });
    if (!r.ok) {
      return r as ConnectorResult<Array<Record<string, unknown>>>;
    }
    /* Tolerate two common response shapes: bare array OR {results:[...]}. */
    const raw = r.data;
    const arr: Array<Record<string, unknown>> = Array.isArray(raw)
      ? (raw as Array<Record<string, unknown>>)
      : Array.isArray((raw as { results?: unknown })?.results)
      ? ((raw as { results: Array<Record<string, unknown>> }).results)
      : [];
    return { ok: true, data: arr, durationMs: r.durationMs };
  }

  private async request<R>(
    path: string,
    isRetry = false,
    shape?: RequestShape,
  ): Promise<ConnectorResult<R>> {
    const start = Date.now();
    const url = `${this.baseUrl!.replace(/\/$/, "")}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: this.authHeader!,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS),
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      emit(this.name, "request_failed", durationMs, "network", path, shape);
      /* A timeout and a refused connection are both "network", and they
         mean opposite things to whoever has to fix it: one system is
         down, the other is up and not answering. Saying which is the
         difference between a useful message and a shrug. */
      const timedOut = (err as Error)?.name === "TimeoutError" || (err as Error)?.name === "AbortError";
      return {
        ok: false,
        code: "network",
        message: timedOut
          ? `${this.name} did not respond within ${CONNECTOR_TIMEOUT_MS / 1000}s`
          : `connector ${this.name} network error: ${(err as Error)?.message ?? "unknown"}`,
        durationMs,
      };
    }
    const durationMs = Date.now() - start;
    /* Refresh-on-401: when the connector is OAuth-backed (workspaceId
       set), a 401 triggers exactly one refresh + retry. If the retry
       also 401s, fall through to the auth_failed return so the assistant
       surfaces the "credentials expired" answer. */
    if (res.status === 401 && this.workspaceId && !isRetry) {
      const refreshed = await refreshConnectorAccessToken({
        workspaceId: this.workspaceId,
        connectorName: this.name,
        fetchImpl: this.refreshFetchImpl,
      });
      if (refreshed) {
        this.authHeader = refreshed.authHeader;
        if (refreshed.baseUrl) this.baseUrl = refreshed.baseUrl;
        /* The refresh orchestrator already fired assistant.oauth_token_refreshed
           with provider-side detail. No double-emit here. */
        return this.request<R>(path, true);
      }
      /* Refresh failed (no refresh token, provider rejected, persist
         error) — fall through to the auth_failed return. */
    }
    if (res.status === 401 || res.status === 403) {
      emit(this.name, "request_failed", durationMs, "auth_failed", path, shape);
      return { ok: false, code: "auth_failed", message: `HTTP ${res.status}`, durationMs };
    }
    if (res.status === 404) {
      emit(this.name, "request_failed", durationMs, "not_found", path, shape);
      return { ok: false, code: "not_found", message: "record not found", durationMs };
    }
    if (res.status === 429) {
      emit(this.name, "request_failed", durationMs, "rate_limited", path, shape);
      return { ok: false, code: "rate_limited", message: "rate-limited by remote", durationMs };
    }
    if (!res.ok) {
      emit(this.name, "request_failed", durationMs, "remote_error", path, shape);
      return {
        ok: false,
        code: "remote_error",
        message: `HTTP ${res.status}`,
        durationMs,
      };
    }
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      emit(this.name, "request_failed", durationMs, "remote_error", path, shape);
      return {
        ok: false,
        code: "remote_error",
        message: "non-JSON response from remote",
        durationMs,
      };
    }
    emit(this.name, "request_succeeded", durationMs, undefined, path, shape);
    return { ok: true, data: body as R, durationMs };
  }

  /* ------------------------------------------------------------------
   * Write methods — required for action-tools (create_external_record,
   * update_external_record). Gated by the vendor preset declaring a
   * `writes` block; connectors without one return validation failure
   * so the action-tool surfaces "this CRM doesn't support writes yet."
   * ----------------------------------------------------------------- */

  async createRecord(
    objectType: string,
    fields: Record<string, unknown>,
  ): Promise<ConnectorResult<{ id: string }>> {
    if (!this.isConfigured()) return notConfigured(this.name, "createRecord");
    if (!this.vendorPreset?.writes) {
      return {
        ok: false,
        code: "validation",
        message: `connector "${this.name}" does not support writes (no vendor preset)`,
      };
    }
    const req = this.vendorPreset.writes.create(objectType.toLowerCase(), fields);
    const r = await this.requestWithBody(
      "POST",
      req.path.startsWith("/") ? req.path : `/${req.path}`,
      req.body,
      false,
      { operation: "createRecord", objectType: objectType.toLowerCase() },
    );
    if (!r.ok) return r as ConnectorResult<{ id: string }>;
    const id = req.extractCreatedId(r.data);
    if (!id) {
      return {
        ok: false,
        code: "remote_error",
        message: "create succeeded but vendor response omitted the new id",
        durationMs: r.durationMs,
      };
    }
    return { ok: true, data: { id }, durationMs: r.durationMs };
  }

  async updateRecord(
    objectType: string,
    id: string,
    fields: Record<string, unknown>,
  ): Promise<ConnectorResult<{ id: string }>> {
    if (!this.isConfigured()) return notConfigured(this.name, "updateRecord");
    if (!this.vendorPreset?.writes) {
      return {
        ok: false,
        code: "validation",
        message: `connector "${this.name}" does not support writes (no vendor preset)`,
      };
    }
    const req = this.vendorPreset.writes.update(objectType.toLowerCase(), id, fields);
    const r = await this.requestWithBody(
      "PATCH",
      req.path.startsWith("/") ? req.path : `/${req.path}`,
      req.body,
      false,
      { operation: "updateRecord", objectType: objectType.toLowerCase() },
    );
    if (!r.ok) return r as ConnectorResult<{ id: string }>;
    return { ok: true, data: { id }, durationMs: r.durationMs };
  }

  async searchRelated(
    parentType: string,
    parentName: string,
    relatedType: string,
    limit = 10,
  ): Promise<ConnectorResult<Array<Record<string, unknown>>>> {
    if (!this.isConfigured()) return notConfigured(this.name, "searchRelated");
    if (!this.vendorPreset?.relatedSearch) {
      return {
        ok: false,
        code: "validation",
        message: `connector "${this.name}" does not support related-record search`,
      };
    }
    const req = this.vendorPreset.relatedSearch.build(
      parentType.toLowerCase(),
      parentName,
      relatedType.toLowerCase(),
      limit,
    );
    const r = await this.request<unknown>(req.path.startsWith("/") ? req.path : `/${req.path}`);
    if (!r.ok) return r as ConnectorResult<Array<Record<string, unknown>>>;
    return { ok: true, data: req.extract(r.data), durationMs: r.durationMs };
  }

  async searchFiltered(
    objectType: string,
    filters: import("./vendor-presets").FilterSpec,
    limit = 10,
  ): Promise<ConnectorResult<Array<Record<string, unknown>>>> {
    if (!this.isConfigured()) return notConfigured(this.name, "searchFiltered");
    if (!this.vendorPreset?.filterSearch) {
      return {
        ok: false,
        code: "validation",
        message: `connector "${this.name}" does not support filter queries`,
      };
    }
    const req = this.vendorPreset.filterSearch.build(objectType.toLowerCase(), filters, limit);
    const r = await this.request<unknown>(req.path.startsWith("/") ? req.path : `/${req.path}`);
    if (!r.ok) return r as ConnectorResult<Array<Record<string, unknown>>>;
    return { ok: true, data: req.extract(r.data), durationMs: r.durationMs };
  }

  async searchAggregate(
    spec: import("./vendor-presets").AggregateSpec,
  ): Promise<ConnectorResult<import("./vendor-presets").AggregateResult>> {
    if (!this.isConfigured()) return notConfigured(this.name, "searchAggregate");
    if (!this.vendorPreset?.aggregateSearch) {
      return {
        ok: false,
        code: "validation",
        message: `connector "${this.name}" does not support aggregate queries`,
      };
    }
    const req = this.vendorPreset.aggregateSearch.build(spec);
    const r = await this.request<unknown>(req.path.startsWith("/") ? req.path : `/${req.path}`);
    if (!r.ok) return r as ConnectorResult<import("./vendor-presets").AggregateResult>;
    return { ok: true, data: req.parse(r.data), durationMs: r.durationMs };
  }

  private async requestWithBody(
    method: "POST" | "PATCH",
    path: string,
    body: Record<string, unknown>,
    isRetry = false,
    shape?: RequestShape,
  ): Promise<ConnectorResult<unknown>> {
    const start = Date.now();
    const url = `${this.baseUrl!.replace(/\/$/, "")}${path}`;
    let res: Response;
    try {
      res = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: this.authHeader!,
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(CONNECTOR_TIMEOUT_MS),
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      emit(this.name, "request_failed", durationMs, "network", path, shape);
      return {
        ok: false,
        code: "network",
        message: `connector ${this.name} network error: ${(err as Error)?.message ?? "unknown"}`,
        durationMs,
      };
    }
    const durationMs = Date.now() - start;
    /* Same refresh-on-401 contract as read path. */
    if (res.status === 401 && this.workspaceId && !isRetry) {
      const refreshed = await refreshConnectorAccessToken({
        workspaceId: this.workspaceId,
        connectorName: this.name,
        fetchImpl: this.refreshFetchImpl,
      });
      if (refreshed) {
        this.authHeader = refreshed.authHeader;
        if (refreshed.baseUrl) this.baseUrl = refreshed.baseUrl;
        return this.requestWithBody(method, path, body, true);
      }
    }
    if (res.status === 401 || res.status === 403) {
      emit(this.name, "request_failed", durationMs, "auth_failed", path, shape);
      return { ok: false, code: "auth_failed", message: `HTTP ${res.status}`, durationMs };
    }
    if (res.status === 404) {
      emit(this.name, "request_failed", durationMs, "not_found", path, shape);
      return { ok: false, code: "not_found", message: "record not found", durationMs };
    }
    if (res.status === 429) {
      emit(this.name, "request_failed", durationMs, "rate_limited", path, shape);
      return { ok: false, code: "rate_limited", message: "rate-limited by remote", durationMs };
    }
    if (!res.ok) {
      /* For writes, surface the vendor's error body if it's JSON — SF
         returns informative messages like "REQUIRED_FIELD_MISSING".
         We pass them through so the action-tool can render a helpful
         "this is what went wrong" answer. */
      let errText = `HTTP ${res.status}`;
      try {
        const errBody = await res.json();
        const msg = Array.isArray(errBody)
          ? (errBody[0]?.message as string | undefined)
          : ((errBody as { message?: string })?.message);
        if (msg) errText = `${errText}: ${msg}`;
      } catch {
        /* non-JSON error body — keep the HTTP status. */
      }
      emit(this.name, "request_failed", durationMs, "remote_error", path, shape);
      return { ok: false, code: "remote_error", message: errText, durationMs };
    }
    /* Salesforce PATCH returns 204 No Content; HubSpot returns the
       full record. Tolerate both — null body is fine for write
       success, callers extract whatever id they need from extractCreatedId. */
    let data: unknown = null;
    if (res.status !== 204) {
      try {
        data = await res.json();
      } catch {
        /* Empty body on a 2xx is still success (some APIs do this on
           PATCH). Leave data as null. */
      }
    }
    emit(this.name, "request_succeeded", durationMs, undefined, path, shape);
    return { ok: true, data, durationMs };
  }
}

function notConfigured(
  name: string,
  op: string,
): ConnectorResult<never> {
  return {
    ok: false,
    code: "not_configured",
    message: `connector "${name}" is not configured (set INSTINCT_REST_CRM_BASE_URL + INSTINCT_REST_CRM_AUTH, or wire per-tenant credentials)`,
  };
}

/**
 * A stable, non-reversible identity for one outbound request.
 *
 * The path is the request: `/contacts/42` and `/contacts?q=acme` are
 * different asks of the same system, and two calls with the same path
 * are the same ask. That makes the path exactly the right fingerprint
 * for "is this system being asked the same thing repeatedly" — and
 * exactly the wrong thing to store, because a search path carries the
 * customer's own text in `?q=`.
 *
 * So it is hashed. Identical requests still collide, which is the only
 * property the redundancy detector needs, and nothing readable about
 * the client's data ever reaches our analytics table.
 */
export function fingerprintPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

/** What a request was, in terms the client would recognize. */
export interface RequestShape {
  /** getRecord | searchRecords | createRecord | updateRecord */
  operation: string;
  /** The caller's domain word: contact, deal, invoice, vehicle. */
  objectType: string;
}

function emit(
  connector: string,
  outcome: "request_succeeded" | "request_failed",
  durationMs: number,
  code: string | undefined,
  path?: string,
  shape?: RequestShape,
): void {
  /* Until 2026-08-23 this recorded THAT a system was called and how
     long it took, and nothing about what was asked of it. That is
     enough to chart latency and nothing else. The question a client
     actually wants answered on the first day — "what is hammering the
     legacy database, and how much of it is the same call twice?" —
     needs the identity of the request, so it is recorded here. */
  try {
    trackEvent(
      outcome === "request_succeeded"
        ? "assistant.connector_succeeded"
        : "assistant.connector_failed",
      "system",
      "system",
      {
        connector,
        duration_ms: durationMs,
        code: code ?? "ok",
        ...(path ? { fingerprint: fingerprintPath(path) } : {}),
        ...(shape
          ? { operation: shape.operation, object_type: shape.objectType }
          : {}),
      },
    );
  } catch {
    /* analytics failures must never break a connector call */
  }
}

function parseEnvObjectMap(raw: string | undefined): Record<string, string> {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") return parsed as Record<string, string>;
  } catch {
    /* ignore */
  }
  return {};
}

/**
 * Build a workspace-aware RestConnector — reads per-tenant credentials
 * from instinct_connector_credentials first, falls back to env-var
 * defaults when no row exists. Callers wanting tenant-isolated
 * connector behavior use this; the env-driven default still serves
 * single-workspace deployments via the registered "rest-default".
 *
 * Least-privilege (agent-aware): when `agentId` is provided (the agent-act
 * path) and the agent is NOT bound to `connectorName` in
 * instinct_agent_connections, this THROWS `ConnectorScopeError` instead of
 * building a connector the agent may not operate. Connector tools pre-check
 * scope and return a typed dispatch failure, so this throw is a defense-in-depth
 * backstop for any un-pre-checked agent path. When `agentId` is omitted (the
 * HUMAN assistant path) behavior is byte-for-byte identical to before.
 */
export async function buildRestConnectorForWorkspace(
  workspaceId: string,
  connectorName = "rest-default",
  agentId?: string,
): Promise<RestConnector> {
  if (agentId) {
    /* Backstop scope check for an agent caller. Lazy import to avoid a module
       cycle and to keep the human path free of the binding lookup. */
    const { assertAgentConnectorScope, ConnectorScopeError, ASSISTANT_SENTINEL } =
      await import("@/lib/agents/connections/scope");
    if (agentId !== ASSISTANT_SENTINEL) {
      const { allowed } = await assertAgentConnectorScope(agentId, workspaceId, connectorName);
      if (!allowed) throw new ConnectorScopeError(agentId, workspaceId, connectorName);
    }
  }
  const creds = await loadConnectorCredentials(workspaceId, connectorName);
  if (creds) {
    return new RestConnector({
      name: connectorName,
      baseUrl: creds.baseUrl,
      authHeader: creds.authHeader,
      objectMap: creds.objectMap,
      /* Only OAuth-backed rows can refresh. Static-bearer rows leave
         workspaceId unset so a 401 returns directly (no refresh path). */
      ...(creds.authType === "oauth2" ? { workspaceId } : {}),
    });
  }
  /* No DB row → fall through to env-var defaults. */
  return new RestConnector({ name: connectorName });
}

/* Side-effect registration so importing this file (or the connectors
 * index barrel) makes the default REST connector discoverable. The
 * env-default instance stays registered for single-workspace deploys;
 * workspace-aware callers should invoke buildRestConnectorForWorkspace
 * to get per-tenant credentials. */
registerConnector(new RestConnector());

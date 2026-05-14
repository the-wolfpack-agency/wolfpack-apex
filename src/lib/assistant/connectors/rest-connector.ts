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
import { trackEvent } from "@/lib/analytics";
import { registerConnector } from "./registry";

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
}

export class RestConnector implements Connector {
  readonly name: string;
  readonly description = "Generic REST API adapter (configurable per tenant via env).";
  private readonly baseUrl?: string;
  private readonly authHeader?: string;
  private readonly objectMap: Record<string, string>;
  private readonly fetchImpl: typeof fetch;

  constructor(cfg: RestConnectorConfig = {}) {
    this.name = cfg.name ?? "rest-default";
    this.baseUrl = cfg.baseUrl ?? process.env.INSTINCT_REST_CRM_BASE_URL;
    this.authHeader = cfg.authHeader ?? process.env.INSTINCT_REST_CRM_AUTH;
    this.objectMap = {
      ...DEFAULT_OBJECT_MAP,
      ...(cfg.objectMap ?? parseEnvObjectMap(process.env.INSTINCT_REST_CRM_OBJECT_MAP)),
    };
    this.fetchImpl = cfg.fetchImpl ?? fetch;
  }

  isConfigured(): boolean {
    return Boolean(this.baseUrl && this.authHeader);
  }

  async getRecord(
    objectType: string,
    id: string,
  ): Promise<ConnectorResult<Record<string, unknown>>> {
    if (!this.isConfigured()) {
      return notConfigured(this.name, "getRecord");
    }
    const path = this.objectMap[objectType.toLowerCase()] ?? objectType.toLowerCase();
    return this.request<Record<string, unknown>>(`/${path}/${encodeURIComponent(id)}`);
  }

  async searchRecords(
    objectType: string,
    query: string,
    limit = 10,
  ): Promise<ConnectorResult<Array<Record<string, unknown>>>> {
    if (!this.isConfigured()) {
      return notConfigured(this.name, "searchRecords");
    }
    if (!query || query.trim().length < 2) {
      return {
        ok: false,
        code: "validation",
        message: "search query must be at least 2 characters",
      };
    }
    const path = this.objectMap[objectType.toLowerCase()] ?? objectType.toLowerCase();
    const url = `/${path}?q=${encodeURIComponent(query)}&limit=${limit}`;
    const r = await this.request<unknown>(url);
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
      });
    } catch (err) {
      const durationMs = Date.now() - start;
      emit(this.name, "request_failed", durationMs, "network");
      return {
        ok: false,
        code: "network",
        message: `connector ${this.name} network error: ${(err as Error)?.message ?? "unknown"}`,
        durationMs,
      };
    }
    const durationMs = Date.now() - start;
    if (res.status === 401 || res.status === 403) {
      emit(this.name, "request_failed", durationMs, "auth_failed");
      return { ok: false, code: "auth_failed", message: `HTTP ${res.status}`, durationMs };
    }
    if (res.status === 404) {
      emit(this.name, "request_failed", durationMs, "not_found");
      return { ok: false, code: "not_found", message: "record not found", durationMs };
    }
    if (res.status === 429) {
      emit(this.name, "request_failed", durationMs, "rate_limited");
      return { ok: false, code: "rate_limited", message: "rate-limited by remote", durationMs };
    }
    if (!res.ok) {
      emit(this.name, "request_failed", durationMs, "remote_error");
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
      emit(this.name, "request_failed", durationMs, "remote_error");
      return {
        ok: false,
        code: "remote_error",
        message: "non-JSON response from remote",
        durationMs,
      };
    }
    emit(this.name, "request_succeeded", durationMs, undefined);
    return { ok: true, data: body as R, durationMs };
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

function emit(
  connector: string,
  outcome: "request_succeeded" | "request_failed",
  durationMs: number,
  code: string | undefined,
): void {
  /* The analytics layer's typed event registry doesn't yet know about
     these — register in src/lib/analytics.ts during wire-in. */
  try {
    trackEvent(
      outcome === "request_succeeded"
        ? "assistant.connector_succeeded"
        : "assistant.connector_failed",
      "system",
      "system",
      { connector, duration_ms: durationMs, code: code ?? "ok" },
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

/* Side-effect registration so importing this file (or the connectors
 * index barrel) makes the default REST connector discoverable. */
registerConnector(new RestConnector());

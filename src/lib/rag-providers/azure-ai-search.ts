/**
 * azure-ai-search.ts
 *
 * VectorStore adapter for Azure AI Search, implemented against the REST API.
 * No SDK dependency — uses global fetch().
 *
 * Every operation:
 *   - NEVER throws; wraps all I/O in try/catch.
 *   - Emits `rag.vector_{op}_ok` on success, `rag.vector_{op}_failed` on failure
 *     via the analytics shim (userId = "system", role = "system" — writes/health
 *     checks can happen outside a user request).
 *   - Measures duration with performance.now().
 *   - Injects `tenant_id eq '<tenantId>'` into every filter so a tenant can
 *     never read another tenant's docs (hard guardrail — analogous to RLS).
 */

import type {
  VectorDoc,
  VectorSearchHit,
  VectorSearchOptions,
  VectorStore,
} from "@/lib/rag-providers/types";
import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";

const PROVIDER = "azure_ai_search";
const DEFAULT_API_VERSION = "2024-07-01";
const SYSTEM_USER = "system";
const SYSTEM_ROLE = "system";

export interface AzureAiSearchConfig {
  endpoint: string;
  apiKey: string;
  index: string;
  apiVersion?: string;
}

/**
 * Build the base URL for a given Azure AI Search operation on this index.
 * Strips a trailing slash from the endpoint so we never double-slash.
 */
function baseUrl(cfg: AzureAiSearchConfig, path: string): string {
  const endpoint = cfg.endpoint.replace(/\/+$/, "");
  const version = cfg.apiVersion ?? DEFAULT_API_VERSION;
  return `${endpoint}/indexes/${encodeURIComponent(cfg.index)}${path}?api-version=${version}`;
}

function headers(cfg: AzureAiSearchConfig): Record<string, string> {
  return {
    "api-key": cfg.apiKey,
    "Content-Type": "application/json",
  };
}

/**
 * Compose a tenant-scoped filter. We ALWAYS inject `tenant_id eq '<id>'` so
 * cross-tenant reads are impossible even if a caller forgets to scope.
 * If the caller passes additional filter keys, they're ANDed in using Azure's
 * OData syntax (eq, with single-quote-escaped string values).
 */
function buildFilter(tenantId: string, extra?: Record<string, unknown>): string {
  const safeTenant = tenantId.replace(/'/g, "''");
  const parts: string[] = [`tenant_id eq '${safeTenant}'`];
  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value === undefined || value === null) continue;
      if (typeof value === "string") {
        parts.push(`${key} eq '${value.replace(/'/g, "''")}'`);
      } else if (typeof value === "number" || typeof value === "boolean") {
        parts.push(`${key} eq ${value}`);
      }
      // silently skip complex filter values — Azure OData has no object support
    }
  }
  return parts.join(" and ");
}

function errMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}

export function createAzureAiSearchStore(cfg: AzureAiSearchConfig): VectorStore {
  return {
    name: PROVIDER,

    async upsert(docs: VectorDoc[]): Promise<{ written: number }> {
      const start = performance.now();
      try {
        const value = docs.map((d) => ({
          "@search.action": "mergeOrUpload",
          id: d.id,
          text: d.text,
          embedding: d.embedding,
          tenant_id: d.tenantId,
          ...d.metadata,
        }));

        const res = await fetch(baseUrl(cfg, "/docs/index"), {
          method: "POST",
          headers: headers(cfg),
          body: JSON.stringify({ value }),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`azure_ai_search upsert HTTP ${res.status}: ${detail}`);
        }

        const duration_ms = performance.now() - start;
        emitRagEvent("rag.vector_upsert_ok", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          doc_count: docs.length,
          duration_ms,
        });
        return { written: docs.length };
      } catch (err) {
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.vector_upsert_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          error: errMessage(err),
          duration_ms,
        });
        return { written: 0 };
      }
    },

    async search(opts: VectorSearchOptions): Promise<VectorSearchHit[]> {
      const start = performance.now();
      const mode = opts.mode ?? "hybrid";
      try {
        const topK = opts.topK ?? 10;
        const filter = buildFilter(opts.tenantId, opts.filter);

        const body: Record<string, unknown> = {
          filter,
          top: topK,
        };

        if (mode === "vector" || mode === "hybrid" || mode === "semantic") {
          if (!opts.queryEmbedding) {
            throw new Error(
              `azure_ai_search ${mode} search requires queryEmbedding`,
            );
          }
          body.vectorQueries = [
            {
              kind: "vector",
              vector: opts.queryEmbedding,
              fields: "embedding",
              k: topK,
            },
          ];
        }

        if (mode === "keyword" || mode === "hybrid" || mode === "semantic") {
          body.search = opts.query;
        }

        if (mode === "semantic") {
          body.queryType = "semantic";
          body.semanticConfiguration = "default";
        }

        const res = await fetch(baseUrl(cfg, "/docs/search"), {
          method: "POST",
          headers: headers(cfg),
          body: JSON.stringify(body),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`azure_ai_search search HTTP ${res.status}: ${detail}`);
        }

        const json = (await res.json()) as {
          value?: Array<Record<string, unknown>>;
        };
        const hits: VectorSearchHit[] = (json.value ?? []).map((row) => {
          const {
            id,
            text,
            "@search.score": score,
            ...rest
          } = row as Record<string, unknown> & {
            id?: string;
            text?: string;
            "@search.score"?: number;
          };
          return {
            id: String(id ?? ""),
            text: String(text ?? ""),
            score: typeof score === "number" ? score : 0,
            metadata: rest,
          };
        });

        const duration_ms = performance.now() - start;
        emitRagEvent("rag.vector_query_ok", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          hit_count: hits.length,
          duration_ms,
          mode,
        });
        return hits;
      } catch (err) {
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.vector_query_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          error: errMessage(err),
          duration_ms,
          mode,
        });
        return [];
      }
    },

    async delete(ids: string[], tenantId: string): Promise<{ deleted: number }> {
      const start = performance.now();
      try {
        // Azure AI Search delete uses the same /docs/index endpoint with
        // @search.action = "delete". We include tenant_id in the body so the
        // doc key is still unique per tenant (tenant_id is the doc's tenant,
        // not a filter — but having it in the body guards against typos).
        const value = ids.map((id) => ({
          "@search.action": "delete",
          id,
          tenant_id: tenantId,
        }));

        const res = await fetch(baseUrl(cfg, "/docs/index"), {
          method: "POST",
          headers: headers(cfg),
          body: JSON.stringify({ value }),
        });

        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`azure_ai_search delete HTTP ${res.status}: ${detail}`);
        }

        const duration_ms = performance.now() - start;
        emitRagEvent("rag.vector_delete_ok", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          doc_count: ids.length,
          duration_ms,
        });
        return { deleted: ids.length };
      } catch (err) {
        const duration_ms = performance.now() - start;
        emitRagEvent("rag.vector_delete_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          error: errMessage(err),
          duration_ms,
        });
        return { deleted: 0 };
      }
    },

    async health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
      const start = performance.now();
      try {
        const res = await fetch(baseUrl(cfg, ""), {
          method: "GET",
          headers: headers(cfg),
        });
        const latencyMs = performance.now() - start;

        if (!res.ok) {
          const detail = `HTTP ${res.status}`;
          emitRagEvent("rag.vector_health_failed", SYSTEM_USER, SYSTEM_ROLE, {
            provider: PROVIDER,
            error: detail,
            duration_ms: latencyMs,
          });
          return { ok: false, latencyMs, detail };
        }

        emitRagEvent("rag.vector_health_ok", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          duration_ms: latencyMs,
        });
        return { ok: true, latencyMs };
      } catch (err) {
        const latencyMs = performance.now() - start;
        const detail = errMessage(err);
        emitRagEvent("rag.vector_health_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER,
          error: detail,
          duration_ms: latencyMs,
        });
        return { ok: false, latencyMs, detail };
      }
    },
  };
}

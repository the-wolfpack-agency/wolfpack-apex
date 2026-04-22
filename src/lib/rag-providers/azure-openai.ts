/**
 * azure-openai.ts
 *
 * Azure OpenAI embedding adapter implementing the EmbeddingProvider interface.
 *
 * Operates against the Azure OpenAI embeddings REST API:
 *   POST {endpoint}/openai/deployments/{deployment}/embeddings?api-version={version}
 *   Header: api-key: {apiKey}
 *   Body:   { input: string[] }
 *   Resp:   { data: [{ embedding: number[], index: number }, ...] }
 *
 * Contract:
 *   - NEVER throws; all failures surface as [] + a `rag.embedding_failed` analytics event.
 *   - On success, emits `rag.embedding_ok` with provider/model/input_count/duration_ms.
 *   - Empty input returns [] with no network call (still silent — no event).
 *   - Caches `dimensions` from the first successful response; null beforehand.
 *   - Response vectors are re-sorted by `index` to defend against out-of-order responses.
 */

import type { EmbeddingProvider } from "@/lib/rag-providers/types";
import { emitRagEvent } from "@/lib/rag-providers/analytics-shim";

export interface AzureOpenAIConfig {
  endpoint: string;
  apiKey: string;
  deployment: string;
  apiVersion?: string;
}

const DEFAULT_API_VERSION = "2024-02-15-preview";
const PROVIDER_NAME = "azure_openai";
const SYSTEM_USER = "system";
const SYSTEM_ROLE = "system";

export function createAzureOpenAIEmbedder(cfg: AzureOpenAIConfig): EmbeddingProvider {
  const apiVersion = cfg.apiVersion ?? DEFAULT_API_VERSION;
  const endpoint = cfg.endpoint.replace(/\/+$/, "");
  const url = `${endpoint}/openai/deployments/${cfg.deployment}/embeddings?api-version=${apiVersion}`;

  let cachedDimensions: number | null = null;

  const provider: EmbeddingProvider = {
    name: PROVIDER_NAME,
    model: cfg.deployment,
    get dimensions(): number | null {
      return cachedDimensions;
    },

    async embed(texts: string[]): Promise<number[][]> {
      if (!Array.isArray(texts) || texts.length === 0) {
        return [];
      }

      const start = performance.now();

      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            "api-key": cfg.apiKey,
            "content-type": "application/json",
          },
          body: JSON.stringify({ input: texts }),
        });

        if (!res.ok) {
          const detail = await safeReadText(res);
          const duration_ms = performance.now() - start;
          await emitRagEvent("rag.embedding_failed", SYSTEM_USER, SYSTEM_ROLE, {
            provider: PROVIDER_NAME,
            model: cfg.deployment,
            input_count: texts.length,
            error: `HTTP ${res.status}: ${detail}`,
            duration_ms,
          });
          return [];
        }

        const json = (await res.json()) as {
          data?: Array<{ embedding: number[]; index: number }>;
        };

        if (!json || !Array.isArray(json.data)) {
          const duration_ms = performance.now() - start;
          await emitRagEvent("rag.embedding_failed", SYSTEM_USER, SYSTEM_ROLE, {
            provider: PROVIDER_NAME,
            model: cfg.deployment,
            input_count: texts.length,
            error: "Malformed response: missing data[]",
            duration_ms,
          });
          return [];
        }

        const sorted = [...json.data].sort((a, b) => a.index - b.index);
        const embeddings = sorted.map((d) => d.embedding);

        if (cachedDimensions === null && embeddings.length > 0 && Array.isArray(embeddings[0])) {
          cachedDimensions = embeddings[0].length;
        }

        const duration_ms = performance.now() - start;
        await emitRagEvent("rag.embedding_ok", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER_NAME,
          model: cfg.deployment,
          input_count: texts.length,
          duration_ms,
        });

        return embeddings;
      } catch (err) {
        const duration_ms = performance.now() - start;
        await emitRagEvent("rag.embedding_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER_NAME,
          model: cfg.deployment,
          input_count: texts.length,
          error: err instanceof Error ? err.message : String(err),
          duration_ms,
        });
        return [];
      }
    },

    async health(): Promise<{ ok: boolean; latencyMs: number; detail?: string }> {
      const start = performance.now();
      try {
        const out = await provider.embed(["ping"]);
        const latencyMs = performance.now() - start;
        if (out.length === 1 && Array.isArray(out[0]) && out[0].length > 0) {
          return { ok: true, latencyMs };
        }
        return {
          ok: false,
          latencyMs,
          detail: "embed(ping) returned no vectors",
        };
      } catch (err) {
        const latencyMs = performance.now() - start;
        return {
          ok: false,
          latencyMs,
          detail: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  return provider;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    return t.slice(0, 500);
  } catch {
    return "<unreadable body>";
  }
}

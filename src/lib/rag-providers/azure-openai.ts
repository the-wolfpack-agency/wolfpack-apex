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

import { isRetryableError, retryDelayMs } from "@/lib/ai/router";
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

      /* ONE RETRY, AS A LOOP RATHER THAN A HELPER.
       *
       * A THROTTLE IS NOT A FAILURE, AND THIS TREATED IT AS ONE. Returning []
       * makes the caller report "embedder returned no vector", the Brain drops
       * to keyword-only, and nobody is told. Measured over 90 days: 178 of
       * these were HTTP 429 on text-embedding-3-small. The request was fine,
       * the service was busy, and every one of them silently halved the
       * search.
       *
       * It is also why a question phrased differently from the document fails.
       * Keyword cannot bridge "how much do we owe upfront" to "50% is due
       * within 30 days"; semantic can, and semantic was not running.
       *
       * A loop keeps the retry in one function with one exit, rather than a
       * recursive helper that has to be kept in step with it. */
      for (let attempt = 0; ; attempt += 1) {
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
          /* Retried once, using the ROUTER's classification rather than a
             second opinion, so the two paths cannot drift into disagreeing
             about what a 429 means. */
          if (attempt === 0 && isRetryableError({ status: res.status })) {
            await new Promise((r) =>
              setTimeout(
                r,
                retryDelayMs(
                  {
                    status: res.status,
                    /* Guarded: a real fetch Response always carries headers,
                       but this must not be the thing that throws if it is ever
                       handed a Response-like object that does not. Losing the
                       hint costs a default backoff; throwing would cost the
                       retry entirely, which is the bug being fixed. */
                    headers: { "retry-after": res.headers?.get?.("retry-after") ?? null },
                  },
                  1,
                ),
              ),
            );
            continue;
          }

          const detail = await safeReadText(res);
          const duration_ms = performance.now() - start;
          await emitRagEvent("rag.embedding_failed", SYSTEM_USER, SYSTEM_ROLE, {
            provider: PROVIDER_NAME,
            model: cfg.deployment,
            input_count: texts.length,
            error: `HTTP ${res.status}: ${detail}`,
            duration_ms,
            /* So a throttle that survived a retry is distinguishable from a
               first-try failure when somebody reads these later. */
            retried: attempt > 0,
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
        /* A THROWN network error is retryable too, and this is the shape the
           most recent failures take: 13 "fetch failed" on 2026-08-30. */
        if (attempt === 0 && isRetryableError(err)) {
          await new Promise((r) => setTimeout(r, retryDelayMs(err, 1)));
          continue;
        }
        const duration_ms = performance.now() - start;
        await emitRagEvent("rag.embedding_failed", SYSTEM_USER, SYSTEM_ROLE, {
          provider: PROVIDER_NAME,
          model: cfg.deployment,
          input_count: texts.length,
          error: err instanceof Error ? err.message : String(err),
          duration_ms,
          retried: attempt > 0,
        });
        return [];
      }
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

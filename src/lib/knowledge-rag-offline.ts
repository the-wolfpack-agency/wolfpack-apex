"use client";

/**
 * Knowledge RAG offline wrapper (Stream U2).
 *
 * Wraps the authenticated knowledge endpoint(s) with U1's RAG cache:
 *
 *   - POST /api/knowledge  → ask a question, server replies with
 *     { answer: KnowledgeEntry | null, source: "cache" | "none" | ..., tokens_used }
 *
 * Semantics mirror `assistant-rag-offline.ts`. See that file for the
 * overall contract; everything below is the knowledge-specific
 * adaptation of the server response to AssistantRagResult (same shape,
 * different scope string).
 */

import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  cacheRagResult,
  findCachedRagResult,
} from "@/lib/rag-offline";
import { RagOfflineMissError } from "@/lib/assistant-rag-offline";
import { scheduleDocBodyBackfill } from "@/lib/rag-offline-backfill";

export interface KnowledgeRagSource {
  id: string;
  title?: string;
  score?: number;
}

export interface KnowledgeRagResult {
  answer: string;
  sources: KnowledgeRagSource[];
  from_cache: boolean;
  is_fuzzy?: boolean;
  similarity?: number;
  cached_at_ms?: number;
  source_kind?: string;
  tokens_used?: number;
  /** When cache miss but server returned a null answer explicitly. */
  server_has_no_answer?: boolean;
}

export interface QueryKnowledgeOptions {
  forceRefresh?: boolean;
  minSimilarity?: number;
  repo?: string;
  onAnalytics?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
  isOnline?: () => boolean;
  fetcher?: typeof fetchWithRefresh;
}

function probeOnline(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

export async function queryKnowledgeWithCache(
  query: string,
  opts?: QueryKnowledgeOptions,
): Promise<KnowledgeRagResult> {
  const onAnalytics = opts?.onAnalytics;
  const isOnline = opts?.isOnline ?? probeOnline;
  const fetcher = opts?.fetcher ?? fetchWithRefresh;
  const forceRefresh = opts?.forceRefresh ?? false;
  const minSimilarity = opts?.minSimilarity ?? 0.7;

  const online = isOnline();
  const tryFresh = online || forceRefresh;

  if (tryFresh) {
    try {
      const body: Record<string, unknown> = { question: query };
      if (opts?.repo) body.repo = opts.repo;

      const res = await fetcher("/api/knowledge", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          answer: null | {
            id: string;
            question: string;
            answer: string;
            source: string;
            tags?: string[];
          };
          source?: string;
          tokens_used?: number;
        };

        if (data.answer && typeof data.answer.answer === "string") {
          const sources: KnowledgeRagSource[] = [
            { id: data.answer.id, title: data.answer.question, score: 1 },
          ];
          try {
            await cacheRagResult(
              "knowledge",
              {
                query,
                retrieved_docs: [
                  {
                    id: data.answer.id,
                    title: data.answer.question,
                    content: data.answer.answer,
                  },
                ],
                answer: data.answer.answer,
                sources,
                scope: "knowledge",
              },
              onAnalytics ? { onAnalytics } : undefined,
            );
          } catch {
            /* best-effort */
          }

          // Ambient doc-body backfill — today the knowledge scope has
          // no /api/knowledge/[id] endpoint; the scheduler emits
          // `rag.doc_backfill_skipped { reason: "no_endpoint" }` and
          // bails. Left in place so the day we ship that endpoint the
          // backfill lights up with zero wrapper edits.
          scheduleDocBodyBackfill(
            "knowledge",
            sources,
            onAnalytics ? { onAnalytics } : undefined,
          );

          return {
            answer: data.answer.answer,
            sources,
            from_cache: false,
            source_kind: data.source ?? data.answer.source,
            tokens_used: data.tokens_used,
          };
        }

        // Server explicitly says "no cached answer" — do NOT throw
        // RagOfflineMissError (we're online, the server just doesn't
        // know). Return a sentinel the UI can differentiate.
        return {
          answer: "",
          sources: [],
          from_cache: false,
          server_has_no_answer: true,
          source_kind: data.source ?? "none",
          tokens_used: data.tokens_used ?? 0,
        };
      }
      // Non-OK → fall through.
    } catch {
      // Network error → fall through.
    }
  }

  const hit = await findCachedRagResult("knowledge", query, {
    minSimilarity,
    isOffline: !online,
    ...(onAnalytics ? { onAnalytics } : {}),
  });
  if (hit) {
    return {
      answer: hit.entry.answer,
      sources: hit.entry.sources as KnowledgeRagSource[],
      from_cache: true,
      is_fuzzy: hit.isFuzzy,
      similarity: hit.similarity,
      cached_at_ms: hit.entry.cached_at,
    };
  }

  throw new RagOfflineMissError("knowledge", query);
}

export { RagOfflineMissError };

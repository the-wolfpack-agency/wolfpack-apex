"use client";

/**
 * Brain RAG offline wrapper (Stream U2).
 *
 * Wraps POST /api/brain/query — retrieval-only hybrid keyword+semantic
 * search across the Brain library — with U1's RAG cache.
 *
 * Server response shape (see `src/app/api/brain/query/route.ts`):
 *   { query, hits: QueryHit[], keyword_hits, semantic_hits, latency_ms,
 *     tokens_used, query_log_id }
 *
 * The Brain endpoint is a pure retriever: there is no single "answer"
 * string, only a ranked list of chunks. We synthesize the "answer" as
 * the top-hit snippet for cache-hit rendering and keep the full hit
 * list in `sources` so the UI can render each chunk exactly as if it
 * came fresh from the server.
 *
 * See `assistant-rag-offline.ts` for the shared contract; this file
 * is the Brain-specific adaptation.
 */

import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  cacheRagResult,
  findCachedRagResult,
} from "@/lib/rag-offline";
import { RagOfflineMissError } from "@/lib/assistant-rag-offline";
import { scheduleDocBodyBackfill } from "@/lib/rag-offline-backfill";

export interface BrainQueryHit {
  chunk_id: string;
  document_id: string;
  document_filename: string;
  document_kind: string;
  chunk_idx: number;
  content: string;
  score: number;
  source: "keyword" | "semantic" | "keyword+semantic";
  snippet: string;
}

export interface BrainRagResult {
  /** For UI-uniform rendering: top hit's snippet (or empty). */
  answer: string;
  /** Full hit list — UIs that render per-chunk cards use this. */
  hits: BrainQueryHit[];
  /** Normalized for the RagSnapshotBadge helpers. */
  sources: Array<{ id: string; title?: string; score?: number }>;
  from_cache: boolean;
  is_fuzzy?: boolean;
  similarity?: number;
  cached_at_ms?: number;
  keyword_hits?: number;
  semantic_hits?: number;
  latency_ms?: number;
  tokens_used?: number;
  query_log_id?: number;
}

export interface QueryBrainOptions {
  forceRefresh?: boolean;
  minSimilarity?: number;
  limit?: number;
  kind?: string;
  uploadedBy?: string;
  conversationId?: string | null;
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

interface CachedBrainExtras {
  hits: BrainQueryHit[];
  keyword_hits?: number;
  semantic_hits?: number;
  latency_ms?: number;
  tokens_used?: number;
  query_log_id?: number;
}

/**
 * Brain cache also stashes the full hit list so offline renders are
 * pixel-identical to fresh renders. We stuff the extras into each
 * `retrieved_docs` row's `content` as a JSON blob on the first doc,
 * plus a dedicated `__brain_extras__` sentinel doc. On hit we pull the
 * sentinel out.
 *
 * Why a sentinel doc instead of a custom field? U1's `CachedRagEntry`
 * is the canonical shape — we don't want to leak Brain-only fields
 * into the cross-scope contract. Packing the extras into one reserved
 * retrieved_doc keeps the shape generic.
 */
const BRAIN_EXTRAS_MARKER = "__brain_extras__";

function packBrainExtras(extras: CachedBrainExtras): {
  id: string;
  title: string;
  content: string;
} {
  return {
    id: BRAIN_EXTRAS_MARKER,
    title: BRAIN_EXTRAS_MARKER,
    content: JSON.stringify(extras),
  };
}

function unpackBrainExtras(
  docs: Array<{ id: string; title?: string; content?: string }>,
): CachedBrainExtras | null {
  const sentinel = docs.find((d) => d.id === BRAIN_EXTRAS_MARKER);
  if (!sentinel || !sentinel.content) return null;
  try {
    return JSON.parse(sentinel.content) as CachedBrainExtras;
  } catch {
    return null;
  }
}

export async function queryBrainWithCache(
  query: string,
  opts?: QueryBrainOptions,
): Promise<BrainRagResult> {
  const onAnalytics = opts?.onAnalytics;
  const isOnline = opts?.isOnline ?? probeOnline;
  const fetcher = opts?.fetcher ?? fetchWithRefresh;
  const forceRefresh = opts?.forceRefresh ?? false;
  const minSimilarity = opts?.minSimilarity ?? 0.7;

  const online = isOnline();
  const tryFresh = online || forceRefresh;

  if (tryFresh) {
    try {
      const body: Record<string, unknown> = { query };
      if (opts?.limit !== undefined) body.limit = opts.limit;
      if (opts?.kind) body.kind = opts.kind;
      if (opts?.uploadedBy) body.uploaded_by = opts.uploadedBy;
      if (opts?.conversationId !== undefined) {
        body.conversation_id = opts.conversationId;
      }

      const res = await fetcher("/api/brain/query", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          query: string;
          hits: BrainQueryHit[];
          keyword_hits?: number;
          semantic_hits?: number;
          latency_ms?: number;
          tokens_used?: number;
          query_log_id?: number;
        };

        const hits = Array.isArray(data.hits) ? data.hits : [];
        const sources = hits.map((h) => ({
          id: h.chunk_id,
          title: `${h.document_filename} #${h.chunk_idx}`,
          score: h.score,
        }));
        const topSnippet = hits.length > 0 ? hits[0].snippet : "";

        try {
          await cacheRagResult(
            "brain",
            {
              query,
              retrieved_docs: [
                packBrainExtras({
                  hits,
                  keyword_hits: data.keyword_hits,
                  semantic_hits: data.semantic_hits,
                  latency_ms: data.latency_ms,
                  tokens_used: data.tokens_used,
                  query_log_id: data.query_log_id,
                }),
                ...hits.map((h) => ({
                  id: h.chunk_id,
                  title: h.document_filename,
                  content: h.content,
                })),
              ],
              answer: topSnippet,
              sources,
              scope: "brain",
            },
            onAnalytics ? { onAnalytics } : undefined,
          );
        } catch {
          /* best-effort */
        }

        // Ambient doc-body backfill. `sources[].id` is a chunk_id, but
        // the /api/brain/documents/[id] endpoint is keyed by
        // document_id — so we dedupe hits down to unique documents and
        // schedule against THOSE. Chunk content is already in-snapshot;
        // what we need offline is the full document body for deep
        // linking from a source chip.
        const seenDocs = new Set<string>();
        const docSources: Array<{ id: string; title?: string }> = [];
        for (const h of hits) {
          if (seenDocs.has(h.document_id)) continue;
          seenDocs.add(h.document_id);
          docSources.push({ id: h.document_id, title: h.document_filename });
        }
        scheduleDocBodyBackfill(
          "brain",
          docSources,
          onAnalytics ? { onAnalytics } : undefined,
        );

        return {
          answer: topSnippet,
          hits,
          sources,
          from_cache: false,
          keyword_hits: data.keyword_hits,
          semantic_hits: data.semantic_hits,
          latency_ms: data.latency_ms,
          tokens_used: data.tokens_used,
          query_log_id: data.query_log_id,
        };
      }
    } catch {
      // Network error → fall through.
    }
  }

  const hit = await findCachedRagResult<{
    id: string;
    title?: string;
    content?: string;
  }>("brain", query, {
    minSimilarity,
    isOffline: !online,
    ...(onAnalytics ? { onAnalytics } : {}),
  });
  if (hit) {
    const docs = hit.entry.retrieved_docs ?? [];
    const extras = unpackBrainExtras(docs);
    return {
      answer: hit.entry.answer,
      hits: extras?.hits ?? [],
      sources: hit.entry.sources,
      from_cache: true,
      is_fuzzy: hit.isFuzzy,
      similarity: hit.similarity,
      cached_at_ms: hit.entry.cached_at,
      keyword_hits: extras?.keyword_hits,
      semantic_hits: extras?.semantic_hits,
      latency_ms: extras?.latency_ms,
      tokens_used: extras?.tokens_used,
      query_log_id: extras?.query_log_id,
    };
  }

  throw new RagOfflineMissError("brain", query);
}

export { RagOfflineMissError };

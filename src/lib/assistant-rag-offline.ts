"use client";

/**
 * Assistant RAG offline wrapper (Stream U2).
 *
 * Thin client-side helper that wraps the authenticated assistant
 * endpoint. Delegates cache lookup/write to U1's `rag-offline.ts`
 * primitive. Transparent to callers:
 *
 *   - Online + !forceRefresh → call the endpoint, cache the result,
 *     return { from_cache: false }.
 *   - Online but fetch throws → fall through to cache.
 *   - Offline OR forceRefresh with no network → look up cache,
 *     return { from_cache: true, ... } or throw RagOfflineMissError.
 *
 * Analytics contract (U1 owns the emitters — we just plumb state):
 *   rag.result_cached        fired by `cacheRagResult`
 *   rag.served_from_cache    fired by `findCachedRagResult` on hit
 *   rag.cache_miss_offline   fired by `findCachedRagResult` when
 *                            isOffline=true and no hit
 *
 * We pass `isOffline` into `findCachedRagResult` so U1 fires the miss
 * event at exactly the right moment. We do NOT emit any of these
 * events directly — double-emission would pollute the learning loop.
 *
 * The assistant endpoint is POST /api/assistant — the server takes
 * { message, conversationId?, pageContext?, attachments?, fileContents? }
 * and replies with { response, source, tokensUsed, conversationId,
 * messageId, gateResults? }. We adapt that to the common
 * AssistantRagResult shape below so all three wrappers speak the same
 * language to their UIs.
 */

import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  cacheRagResult,
  findCachedRagResult,
} from "@/lib/rag-offline";
import { scheduleDocBodyBackfill } from "@/lib/rag-offline-backfill";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface AssistantRagSource {
  id: string;
  title?: string;
  score?: number;
}

export interface AssistantRagResult {
  answer: string;
  sources: AssistantRagSource[];
  from_cache: boolean;
  is_fuzzy?: boolean;
  similarity?: number;
  cached_at_ms?: number;
  /** Opaque server-assigned id when fresh; undefined on a cache hit. */
  message_id?: string;
  /** Opaque server-assigned conversation id when fresh. */
  conversation_id?: string | null;
  /** Which source the server classified the answer as (e.g. "knowledge_cache", "ai"). */
  source_kind?: string;
  tokens_used?: number;
  /** Connector name when the answer came from a CRM/external system
   *  (salesforce, hubspot, github, …). The chat UI renders this as a
   *  styled vendor badge alongside "Zero tokens". Undefined for non-
   *  connector answers. */
  connector_source?: string;
  /** Related Instinct pages the answer touches — passes through from
   *  the server so chip rows render on the offline-RAG path too. */
  related_pages?: Array<Record<string, unknown>>;
  /** Structured form spec (create email / message / calendar event /
   *  task) — surfaced to the chat UI which renders ChatActionForm. */
  form?: unknown;
  /** Interactive widget spec (calendar grid, email thread, …) the
   *  chat UI renders via ChatWidget. */
  widget?: unknown;
  /** Per-turn correlation id from the server. The chat UI forwards
   *  it on widget + form interaction events so client-side analytics
   *  rows join the same funnel as the originating turn. */
  workflowId?: string;
}

export interface QueryAssistantOptions {
  forceRefresh?: boolean;
  minSimilarity?: number;
  /** Pass-through to POST body, matches existing server contract. */
  conversationId?: string | null;
  pageContext?: string;
  contextData?: Record<string, unknown>;
  /**
   * Test seam — when provided, this emitter is forwarded INTO U1's
   * `cacheRagResult` / `findCachedRagResult`, replacing U1's default
   * POST-to-/api/analytics emitter. The wrapper does not fire any
   * RAG events of its own; U1 owns the event surface.
   */
  onAnalytics?: (
    event: string,
    metadata: Record<string, string | number | boolean>,
  ) => void;
  /** Test seam — override navigator.onLine probe. */
  isOnline?: () => boolean;
  /** Test seam — override fetchWithRefresh. */
  fetcher?: typeof fetchWithRefresh;
}

export class RagOfflineMissError extends Error {
  public readonly query: string;
  public readonly scope: "assistant" | "knowledge" | "brain";
  constructor(scope: "assistant" | "knowledge" | "brain", query: string) {
    super(
      `No cached RAG result for scope="${scope}" query="${query.slice(0, 80)}"`,
    );
    this.name = "RagOfflineMissError";
    this.scope = scope;
    this.query = query;
  }
}

function probeOnline(): boolean {
  return typeof navigator !== "undefined" ? navigator.onLine : true;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function queryAssistantWithCache(
  query: string,
  opts?: QueryAssistantOptions,
): Promise<AssistantRagResult> {
  const onAnalytics = opts?.onAnalytics;
  const isOnline = opts?.isOnline ?? probeOnline;
  const fetcher = opts?.fetcher ?? fetchWithRefresh;
  const forceRefresh = opts?.forceRefresh ?? false;
  const minSimilarity = opts?.minSimilarity ?? 0.7;

  const online = isOnline();
  const tryFresh = online || forceRefresh;

  if (tryFresh) {
    try {
      const body: Record<string, unknown> = { message: query };
      if (opts?.conversationId !== undefined) {
        body.conversationId = opts.conversationId;
      }
      if (opts?.pageContext) body.pageContext = opts.pageContext;
      if (opts?.contextData) body.contextData = opts.contextData;

      const res = await fetcher("/api/assistant", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });

      if (res.ok) {
        const data = (await res.json()) as {
          response?: string;
          source?: string;
          tokensUsed?: number;
          conversationId?: string | null;
          messageId?: string;
          sources?: AssistantRagSource[];
          docs?: Array<{ id: string; title?: string; score?: number; content?: string }>;
          connectorSource?: string;
          relatedPages?: Array<Record<string, unknown>>;
          form?: unknown;
          widget?: unknown;
          workflowId?: string;
        };

        const answer = data.response ?? "";
        const sources = data.sources ?? [];
        const retrievedDocs =
          data.docs ??
          sources.map((s) => ({ id: s.id, title: s.title, score: s.score }));

        // cacheRagResult fires `rag.result_cached` itself. We just plumb
        // the test-seam onAnalytics through so tests can assert.
        try {
          await cacheRagResult(
            "assistant",
            {
              query,
              retrieved_docs: retrievedDocs,
              answer,
              sources,
              scope: "assistant",
            },
            onAnalytics ? { onAnalytics } : undefined,
          );
        } catch {
          /* cache write is best-effort */
        }

        // Ambient doc-body backfill — fire-and-forget, never throws.
        // See rag-offline-backfill.ts for concurrency + dedup rules.
        scheduleDocBodyBackfill(
          "assistant",
          sources,
          onAnalytics ? { onAnalytics } : undefined,
        );

        return {
          answer,
          sources,
          from_cache: false,
          message_id: data.messageId,
          conversation_id: data.conversationId ?? null,
          source_kind: data.source,
          tokens_used: data.tokensUsed,
          /* Forward connector attribution + related-page chips so the
             chat surface can render the vendor badge + page chips. */
          ...(typeof data.connectorSource === "string" && data.connectorSource
            ? { connector_source: data.connectorSource }
            : {}),
          ...(Array.isArray(data.relatedPages) && data.relatedPages.length > 0
            ? { related_pages: data.relatedPages }
            : {}),
          /* Forward chat-action form spec so the UI can render
             ChatActionForm inline on the no-attachments fast path. */
          ...(data.form && typeof data.form === "object" ? { form: data.form } : {}),
          /* Same for interactive widgets (calendar, email thread, etc.). */
          ...(data.widget && typeof data.widget === "object" ? { widget: data.widget } : {}),
          /* workflow_id passthrough — chat UI forwards on follow-up
           * client analytics events so funnels reconstruct. */
          ...(typeof data.workflowId === "string" ? { workflowId: data.workflowId } : {}),
        };
      }
      // Non-OK response → fall through to cache lookup (we still want
      // offline-like semantics for a 5xx).
    } catch {
      // Network error → fall through.
    }
  }

  // Cache-lookup path. `isOffline` tells U1 whether a total miss should
  // emit `rag.cache_miss_offline` (only meaningful if the network was
  // actually down).
  const hit = await findCachedRagResult("assistant", query, {
    minSimilarity,
    isOffline: !online,
    ...(onAnalytics ? { onAnalytics } : {}),
  });
  if (hit) {
    return {
      answer: hit.entry.answer,
      sources: hit.entry.sources as AssistantRagSource[],
      from_cache: true,
      is_fuzzy: hit.isFuzzy,
      similarity: hit.similarity,
      cached_at_ms: hit.entry.cached_at,
    };
  }

  throw new RagOfflineMissError("assistant", query);
}

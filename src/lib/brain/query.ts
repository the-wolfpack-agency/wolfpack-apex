/**
 * Brain retrieval — keyword + semantic fusion with citation metadata.
 *
 * Merge strategy:
 *   - Run Postgres FTS `keywordSearch()` always (zero-cost, works with
 *     no embeddings configured).
 *   - If embeddings are available AND Qdrant is reachable, embed the
 *     query and `searchBrain()`.
 *   - Merge by chunk_id. Chunks hit by BOTH paths get a score boost and
 *     source="keyword+semantic" — the strongest signal.
 *   - Every query persists to brain_query_log so retrieval quality can
 *     be measured (was a returned chunk later cited by the assistant?).
 */

import { embedBatch, isEmbeddingConfigured } from "./embedder";
import { keywordSearch, logQuery, markQueryCited } from "./repo";
import { readableDocumentIds } from "./audience";
import { searchBrain } from "./qdrant";
import { trackEvent } from "@/lib/analytics";
import type { BrainKind, BrainQueryHit, BrainQueryResult } from "./types";

const DEFAULT_LIMIT = 8;

export interface QueryOpts {
  userId: string;
  userRole: string;
  query: string;
  limit?: number;
  uploadedBy?: string;
  kind?: BrainKind;
  conversationId?: string | null;
}

export interface QueryExecution extends BrainQueryResult {
  /** DB id of the row inserted into brain_query_log — callers can pass
   *  this to markCited() once the assistant's final answer quotes a hit. */
  query_log_id: number;
  /**
   * WHETHER THE OTHER HALF OF THIS SEARCH ACTUALLY RAN.
   *
   * "0 semantic hits" was indistinguishable from "semantic never ran", and on
   * 2026-08-24 that turned out to matter enormously: 252 real brain queries in
   * the previous 30 days, and NOT ONE of them had a semantic hit. 192 were
   * keyword-only and 60 found nothing. The hybrid search had been half dead for
   * at least a month and nothing anywhere said so, because the failure path was
   * a bare `catch {}` with the comment "degrade silently".
   *
   * Callers can now tell the difference, and a non-ok value emits an event.
   */
  semantic_status: SemanticStatus;
}

/** Why the semantic half returned what it returned. */
export type SemanticStatus =
  /** Ran, and matched. */
  | "ok"
  /** Ran, matched nothing. Legitimate for a query about nothing we hold. */
  | "empty"
  /** No embedding provider configured in this deployment. */
  | "not_configured"
  /** Configured, and threw. This is the one that hid for a month. */
  | "failed";

export async function queryBrain(opts: QueryOpts): Promise<QueryExecution> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 20);
  const t0 = Date.now();

  // 1. keyword (always)
  const keyword = await keywordSearch(opts.query, limit, {
    uploadedBy: opts.uploadedBy,
    kind: opts.kind,
    /* Who is asking. Applied inside the query, so a document this role may not
       read is never ranked, never headlined and never counted. */
    role: opts.userRole,
  });

  /* 2. SEMANTIC. Best-effort, but no longer silent.
   *
   * This read `catch { // degrade silently }`. Keyword results ARE still
   * useful, so degrading is right; doing it without a word is not. Measured on
   * 2026-08-24: 252 brain queries over 30 days, zero semantic hits, nobody
   * aware. A keyword-only search is a different product from a hybrid one, and
   * the difference showed up as confidently quoted documents that had nothing
   * to do with the question. */
  let semantic: Awaited<ReturnType<typeof searchBrain>> = [];
  let tokensUsed = 0;
  let semanticStatus: SemanticStatus = "not_configured";
  let semanticError: string | null = null;
  if (isEmbeddingConfigured()) {
    try {
      const emb = await embedBatch([opts.query]);
      if (emb && emb.vectors.length > 0) {
        tokensUsed = emb.tokensUsed;
        const raw = await searchBrain(emb.vectors[0], limit);
        /* THE VECTOR SIDE IS FILTERED AGAINST POSTGRES, not against the point
           payload. The payload does not carry the audience, so filtering there
           would need every point written before this to be backfilled, and a
           point the backfill missed would be a document silently readable by
           anybody. The row that owns the document is the only thing that
           cannot be out of date with itself. */
        const allowed = await readableDocumentIds(
          raw.map((h) => String(h.document_id)),
          opts.userRole,
        );
        semantic = raw.filter((h) => allowed.has(String(h.document_id)));
        if (semantic.length < raw.length) {
          trackEvent("brain.retrieval_audience_filtered", opts.userId, opts.userRole, {
            /* How much of the index a role cannot see. Rising is the gate
               working; flat at zero on a tenant with restricted libraries
               means it is not being applied. */
            withheld: raw.length - semantic.length,
            returned: semantic.length,
          });
        }
        semanticStatus = semantic.length > 0 ? "ok" : "empty";
      } else {
        /* Configured, called, and handed back nothing to search with. That is
           a broken embedder, not an empty index. */
        semanticStatus = "failed";
        semanticError = "embedder returned no vector";
      }
    } catch (err) {
      semanticStatus = "failed";
      semanticError = (err as Error)?.message?.slice(0, 200) ?? "unknown";
    }
  }
  if (semanticStatus !== "ok" && semanticStatus !== "empty") {
    /* Named after system.triple_write_degraded, which exists for exactly this
       shape: a fan-out where one leg can fail without the user seeing an
       error, and therefore must not fail without a record. */
    trackEvent("system.brain_semantic_degraded", opts.userId, opts.userRole, {
      reason: semanticStatus,
      ...(semanticError ? { error: semanticError } : {}),
    });
  }

  // 3. merge by chunk_id
  const byId = new Map<string, BrainQueryHit>();

  for (const k of keyword) {
    byId.set(k.chunk_id, {
      chunk_id: k.chunk_id,
      document_id: k.document_id,
      document_filename: k.filename,
      document_kind: k.kind,
      chunk_idx: k.chunk_idx,
      content: k.content,
      score: Number(k.score) || 0.1,
      source: "keyword",
      snippet: k.headline || truncate(k.content, 180),
    });
  }

  for (const s of semantic) {
    const existing = byId.get(s.chunk_id);
    if (existing) {
      existing.source = "keyword+semantic";
      // Stronger combined signal. Clamp to [0, 1.2] so combined hits
      // still out-rank singletons without breaking downstream UI.
      existing.score = Math.min(1.2, existing.score + 0.3 + s.score * 0.2);
    } else {
      byId.set(s.chunk_id, {
        chunk_id: s.chunk_id,
        document_id: s.document_id,
        document_filename: s.filename,
        document_kind: "other", // payload doesn't carry kind here; joined in repo if needed
        chunk_idx: s.chunk_idx,
        content: s.content,
        score: s.score,
        source: "semantic",
        snippet: truncate(s.content, 180),
      });
    }
  }

  const hits = [...byId.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);

  const latency_ms = Date.now() - t0;

  // 4. persist for the learning loop
  let queryLogId = 0;
  try {
    queryLogId = await logQuery({
      userId: opts.userId,
      userRole: opts.userRole,
      query: opts.query,
      hitChunkIds: hits.map((h) => h.chunk_id),
      keywordHits: keyword.length,
      semanticHits: semantic.length,
      latencyMs: latency_ms,
      tokensUsed,
      conversationId: opts.conversationId ?? null,
    });
  } catch {
    // non-blocking — the user still gets their answer
  }

  if (hits.length > 0) {
    await trackEvent("brain.query_hit", opts.userId, opts.userRole, {
      query_len: opts.query.length,
      hit_count: hits.length,
      keyword_hits: keyword.length,
      semantic_hits: semantic.length,
      latency_ms,
    });
  } else {
    await trackEvent("brain.query_miss", opts.userId, opts.userRole, {
      query_len: opts.query.length,
      latency_ms,
    });
  }

  return {
    query: opts.query,
    hits,
    keyword_hits: keyword.length,
    semantic_hits: semantic.length,
    latency_ms,
    tokens_used: tokensUsed,
    query_log_id: queryLogId,
    semantic_status: semanticStatus,
  };
}

/**
 * Called by the assistant when its generated answer cited one of the
 * Brain hits returned earlier in the same turn. This closes the loop:
 * the brain_query_quality_daily view uses cited=TRUE to track real
 * retrieval effectiveness, not just recall count.
 */
export async function markCited(
  queryLogId: number,
  userId: string,
  userRole: string,
): Promise<void> {
  if (!queryLogId) return;
  try {
    await markQueryCited(queryLogId);
    await trackEvent("brain.query_cited_in_answer", userId, userRole, {
      query_log_id: queryLogId,
    });
  } catch {
    // audit-loop writes are never fatal
  }
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

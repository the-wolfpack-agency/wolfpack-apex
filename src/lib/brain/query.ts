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
import { keywordSearchWithAudience, logQuery, markQueryCited } from "./repo";
import { readableDocumentIds } from "./audience";
import { describeDocuments } from "./repo";
import { searchBrain, SEMANTIC_SCORE_FLOOR } from "./qdrant";
import { reciprocalRankFusion } from "./fusion";
import { shouldExpand } from "./expand-query";
import { trackEvent } from "@/lib/analytics";
import type { BrainKind, BrainQueryHit, BrainQueryResult } from "./types";

const DEFAULT_LIMIT = 8;

export interface QueryOpts {
  /**
   * Rewrite the question into the words documents use, and try again.
   *
   * Injected rather than imported so retrieval never learns how to spend money:
   * the caller owns the model call, and a caller that does not pass this gets
   * the previous behavior exactly. Only invoked when the first pass came back
   * thin, so most questions never reach it.
   */
  expand?: (question: string) => Promise<string>;
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

/**
 * Retrieve, and if the result is thin, ask again in the words documents use.
 *
 * THE FAILURE THIS TARGETS. Four of twelve labeled questions never surface
 * their document, and all four are the same shape: the person and the paper
 * describe one fact differently. "How much do we owe upfront?" against "50%
 * ($6,000.00) is due within 30 days of the execution". No ranking fixes that;
 * neither retriever can match words that are not there.
 *
 * ONE EXTRA CALL, ONLY WHEN THE FIRST PASS WAS THIN. Two thirds of questions
 * already find their document at rank one, and paying a model on every question
 * to help the third that struggles is the fixed-cascade mistake in a different
 * costume. The cheap path stays cheap.
 *
 * THE EXPANSION IS USED FOR RETRIEVAL ONLY. Nothing downstream is told the
 * person asked something they did not: the answer still comes from a document,
 * still gets cited, and still faces the relevance judge. An expansion reaching
 * the answer path would be the model inventing context and calling it
 * retrieval.
 *
 * The ORIGINAL query is what gets logged, so the query log keeps recording what
 * people actually type. An eval set harvested from rewritten questions would
 * grade the product on its own paraphrases.
 */
export async function queryBrain(opts: QueryOpts): Promise<QueryExecution> {
  const first = await queryBrainOnce(opts);

  if (!opts.expand) return first;
  if (!shouldExpand({ hitCount: first.hits.length, topScore: first.hits[0]?.score ?? 0 }, SEMANTIC_SCORE_FLOOR)) {
    return first;
  }

  const rewritten = await opts.expand(opts.query).catch(() => opts.query);
  /* An expansion that changed nothing is not worth a second retrieval. */
  if (rewritten === opts.query) return first;

  const second = await queryBrainOnce({ ...opts, query: rewritten });
  const better = second.hits.length > first.hits.length ||
    (second.hits[0]?.score ?? 0) > (first.hits[0]?.score ?? 0);

  trackEvent("brain.query_expanded", opts.userId, opts.userRole, {
    /* Both, because the pair is the evidence for whether this is worth its
       cost. One without the other says nothing. */
    original: opts.query.slice(0, 120),
    rewritten: rewritten.slice(0, 120),
    first_hits: first.hits.length,
    second_hits: second.hits.length,
    helped: better,
  });

  /* KEEPS THE BETTER OF THE TWO. A rewrite is a guess about vocabulary, and a
     guess that retrieved worse must not replace a result that was merely
     thin. */
  return better ? { ...second, query: opts.query } : first;
}

async function queryBrainOnce(opts: QueryOpts): Promise<QueryExecution> {
  const limit = Math.min(Math.max(opts.limit ?? DEFAULT_LIMIT, 1), 20);
  const t0 = Date.now();

  // 1. keyword (always)
  const keywordResult = await keywordSearchWithAudience(opts.query, limit, {
    uploadedBy: opts.uploadedBy,
    kind: opts.kind,
    /* Who is asking. Applied inside the query, so a document this role may not
       read is never ranked, never headlined and never counted. */
    role: opts.userRole,
  });
  const keyword = keywordResult.hits;

  /* THE AUDIENCE GATE, REPORTED FROM THE PATH THAT ACTUALLY RUNS.
   *
   * This event existed only in the semantic branch below, which is gated on an
   * embedding deployment this tenant has never had. So it read zero for ninety
   * days while the playbook told clients the assistant only quotes what a role
   * may read. The claim was true and the evidence for it did not exist, which
   * is the same thing as no control at all to anybody auditing it.
   *
   * Keyword runs on every single query, so counting here is what makes the
   * number mean something. Rising is the gate working; flat at zero on a
   * tenant with restricted libraries is now genuinely worth investigating,
   * because the instrument is finally pointed at the road. */
  if (keywordResult.withheld > 0) {
    trackEvent("brain.retrieval_audience_filtered", opts.userId, opts.userRole, {
      withheld: keywordResult.withheld,
      returned: keyword.length,
      stage: "keyword",
    });
  }

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
            stage: "semantic",
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

  /* DOCUMENT-LEVEL CONTEXT FOR EVERY HIT, in one query rather than per chunk.
     A chunk that starts mid-sentence cannot tell a reader whether the document
     is worth opening, and that is the only question a list of things to read
     before a meeting answers. */
  const documentIds = Array.from(
    new Set([...keyword.map((k) => String(k.document_id)), ...semantic.map((s) => String(s.document_id))]),
  );
  const documentMeta = await describeDocuments(documentIds);
  const meta = (id: string) => documentMeta.get(String(id));

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
      document_summary: meta(k.document_id)?.summary ?? null,
      document_topics: meta(k.document_id)?.topics ?? null,
      web_url: meta(k.document_id)?.webUrl ?? null,
    });
  }

  for (const s of semantic) {
    const existing = byId.get(s.chunk_id);
    if (existing) {
      existing.source = "keyword+semantic";
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
        document_summary: meta(s.document_id)?.summary ?? null,
        document_topics: meta(s.document_id)?.topics ?? null,
        web_url: meta(s.document_id)?.webUrl ?? null,
      });
    }
  }

  /* FUSED BY RANK, NOT BY SCORE.
   *
   * This added the two scores with a both-lists bonus, a semantic weight and a
   * clamp: `Math.min(1.2, score + 0.3 + s.score * 0.2)`. Three constants, plus
   * FILENAME_MATCH_WEIGHT upstream, all reconciling numbers that share no unit:
   * lexical density over a string against cosine distance in embedding space.
   *
   * Each was added for a real failure and each was chosen by arithmetic rather
   * than evidence. Reciprocal rank fusion reads only the ORDER, so the scales
   * never have to be made comparable, and a document ranked well by both
   * retrievers still outranks one ranked well by either.
   *
   * Kept switchable while it is new: BRAIN_FUSION=score restores the previous
   * behavior. A ranking change that cannot be reverted in one environment
   * variable is one nobody will risk deploying. */
  /* DEFAULT REVERTED TO SCORE FUSION, BY MEASUREMENT.
   *
   * RRF was adopted on a six-pair eval set: MRR 0.557 -> 0.700, and "what are
   * the payment terms in our work order?" moving from rank 7 to rank 1. On a
   * cleaned twelve-pair set the result reverses:
   *
   *   score addition     50% ranked first, MRR 0.544
   *   reciprocal rank    42% ranked first, MRR 0.503
   *
   * Six pairs was too few to decide anything — one question is 17% of that
   * score — which I said before adopting it and then did anyway. The larger
   * set is still small and the gap is close to noise, so this is not a
   * verdict that RRF is wrong. It is that it has not earned the change, and
   * the rule was written for exactly this: ties go to the incumbent, because
   * churn in ranking is how a corpus gets quietly worse one defensible step
   * at a time.
   *
   * BRAIN_FUSION=rrf re-enables it, so the next person with a bigger set can
   * settle it rather than re-implement it. */
  const useRrf = process.env.BRAIN_FUSION === "rrf";
  const hits = useRrf
    ? reciprocalRankFusion(
        keyword.map((h) => ({ ...h, id: h.chunk_id })),
        semantic.map((h) => ({ ...h, id: h.chunk_id })),
      )
        .map((f) => byId.get(f.item.id))
        .filter((h): h is NonNullable<typeof h> => h !== undefined)
        .slice(0, limit)
    : [...byId.values()].sort((a, b) => b.score - a.score).slice(0, limit);

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

  /* ANALYTICS MUST NEVER COST SOMEBODY THEIR ANSWER.
   *
   * These two awaits were unguarded, sitting between the query log write and
   * the return. logQuery directly above has always been wrapped, with the
   * comment "non-blocking — the user still gets their answer". These were not,
   * so a throw here discarded a retrieval that had already succeeded.
   *
   * What that looked like from the outside, measured 2026-08-29:
   *
   *   brain_query_log  "how much do we owe upfront?"  ->  4 hits
   *   quality gate     same question, same second     ->  hit_count 0,
   *                    "asked about this organization with no retrieved
   *                     source to answer", verdict reject
   *   the person       -> "I don't have a confident answer for that."
   *
   * Both records were true. The hits were found, logged, and then thrown away
   * by an exception a few lines later: queryBrain threw, tryBrain caught it and
   * returned its empty context, and the gate reads hitCount as the only thing
   * that decides whether an answer is grounded.
   *
   * It presents as a relevance problem, which is why it survived three wrong
   * hypotheses. It is not: retrieval worked every time. Same shape as the
   * failures this codebase keeps finding, a store that can be empty for two
   * different reasons and a caller that only knows one of them.
   *
   * Fire-and-forget rather than try/catch around an await, so a slow analytics
   * write cannot add latency to a question either. */
  const usage =
    hits.length > 0
      ? trackEvent("brain.query_hit", opts.userId, opts.userRole, {
          query_len: opts.query.length,
          hit_count: hits.length,
          keyword_hits: keyword.length,
          semantic_hits: semantic.length,
          latency_ms,
        })
      : trackEvent("brain.query_miss", opts.userId, opts.userRole, {
          query_len: opts.query.length,
          latency_ms,
        });
  void Promise.resolve(usage).catch(() => {
    /* Recording that a search happened is worth less than the search. */
  });

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

/**
 * Does this chunk read as a spreadsheet row rather than prose?
 *
 * WHY IT MATTERS. A spreadsheet chunks as raw CSV, so quoting it verbatim
 * prints column headers, UUIDs, usernames and participant names into the chat.
 * Measured 2026-08-27 by driving the real assistant: "which hotels were
 * surveyed in August" answered with
 *
 *   3a931b25-...,Firstname,Lastname,ACTIVE,flastname,PCNA,PCNA Dealer General Manager
 *
 * which is both unreadable and a person's record. Redaction catches the email
 * in that row and cannot catch the name, because a name in a CSV column is not
 * a pattern. The row should not be quoted at all.
 *
 * The same content synthesised by a model reads as "Ritz Carlton, Aug 17:
 * accommodations were very nice", which is the answer somebody wanted. So a
 * tabular hit is still good GROUNDING and a bad QUOTE, and this is the
 * distinction the retrieval layer never drew.
 */
export function looksTabular(content: string): boolean {
  const sample = content.slice(0, 600);
  if (!sample.trim()) return false;
  const commas = (sample.match(/,/g) ?? []).length;
  const uuids = (sample.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi) ?? []).length;
  /* Sentences end. A CSV row does not. */
  const sentenceEnds = (sample.match(/[.!?]\s+[A-Z]/g) ?? []).length;
  /* A UUID is never prose. Two commas per sentence-ending is already a table. */
  if (uuids >= 1) return true;
  return commas >= 8 && commas > sentenceEnds * 4;
}

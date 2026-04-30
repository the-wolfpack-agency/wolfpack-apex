/**
 * src/lib/knowledge/qa-cache — semantic Q&A cache with LLM fallback.
 *
 * Powers /knowledge ("Ask a Question") and /assistant (Support mode).
 *
 * Lookup pipeline (askWithCache):
 *   1. Normalize the question (lowercase, collapse whitespace, strip
 *      trailing punctuation).
 *   2. EXACT-MATCH FAST PATH — single-column equality on
 *      question_normalized. Indexed (idx_qa_normalized). When this hits,
 *      the request never embeds, never calls the LLM, and never even
 *      touches the application server's AI client.
 *   3. EMBED + NEAREST-NEIGHBOR — embedBatch() returns 1536-dim vectors
 *      from text-embedding-3-small. Compute cosine similarity in JS over
 *      the candidate rows for the requested surface. If the top match
 *      clears the threshold (DEFAULT_SIM_THRESHOLD), serve it.
 *   4. MISS — call the AI router with a constrained system prompt,
 *      INSERT a new row (source = 'ai_generated'), return the answer.
 *
 * Why JSONB and not pgvector: see migration 108 — pgvector is not
 * provisioned in this deploy. Cosine in JS over a small candidate set
 * (filtered by surface) is fast enough at v1 scale; the lookup helper
 * is the only consumer, so swapping to pgvector is a one-file change
 * once the extension is enabled.
 *
 * Embedding-key absent path: embedBatch() returns null when neither
 * OPENAI_API_KEY nor BRAIN_EMBEDDING_KEY is set. We degrade to a
 * word-overlap Jaccard score over question_normalized so the SAME-
 * QUESTION case still gets a hit even without semantic embeddings.
 *
 * The cache NEVER serves rows that are auto-flagged (high
 * not_helpful_count, no helpful votes). Bad answers stop poisoning the
 * cache as soon as the team votes.
 */

import { query, writeQuery } from "@/lib/db";
import { embedBatch, isEmbeddingConfigured } from "@/lib/brain/embedder";
import { getAIClient } from "@/lib/ai";
import { getObsClient } from "@/lib/obs";
import { getRelevantContext } from "@/lib/assistant/context-resolver";

/* ------------------------------------------------------------------ */
/* Public types                                                        */
/* ------------------------------------------------------------------ */

export type QASurface = "knowledge" | "assistant_support";
export type QASource = "ai_generated" | "internal_doc" | "human_curated";

export interface AskWithCacheArgs {
  question: string;
  surface: QASurface;
  userId?: string;
}

export interface AskWithCacheResult {
  qa_id: string;
  answer: string;
  source: QASource;
  ai_model: string | null;
  ai_generated_at: string | null;
  was_cache_hit: boolean;
  similarity?: number;
  latency_ms: number;
  prompt_tokens?: number;
  completion_tokens?: number;
}

interface QARow extends Record<string, unknown> {
  id: string;
  question_text: string;
  question_normalized: string;
  question_embedding: { dim: number; model: string; vector: number[] } | null;
  answer_text: string;
  source: QASource;
  ai_model: string | null;
  ai_generated_at: string | null;
  surface: "knowledge" | "assistant_support" | "both";
  helpful_count: number;
  not_helpful_count: number;
  lookup_count: number;
}

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

/** Default cosine threshold for treating two questions as semantically equivalent. */
export const DEFAULT_SIM_THRESHOLD = 0.86;
/** Threshold for the JSONB-fallback word-overlap path (looser since features are coarser). */
export const FALLBACK_SIM_THRESHOLD = 0.75;
/** Auto-flag threshold: rows past this are not served. */
export const AUTO_FLAG_NOT_HELPFUL = 5;

/* ------------------------------------------------------------------ */
/* Normalization                                                       */
/* ------------------------------------------------------------------ */

/**
 * Normalize a question for the exact-match fast path.
 *   - lowercases
 *   - collapses whitespace (multiple spaces, tabs, newlines → single space)
 *   - strips trailing punctuation runs (?, ., !, …, etc.)
 */
export function normalizeQuestion(raw: string): string {
  if (!raw) return "";
  return raw
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[?.!…,;:]+$/u, "")
    .trim();
}

/* ------------------------------------------------------------------ */
/* Similarity                                                          */
/* ------------------------------------------------------------------ */

/** Cosine similarity over two equally-sized vectors. Returns NaN on length mismatch. */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (!a.length || a.length !== b.length) return NaN;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/**
 * Word-overlap Jaccard score for the no-embedding-key fallback path. We
 * tokenize on whitespace + drop stop words so "how do I reset password"
 * and "how to reset password" still score above threshold.
 */
const STOP_WORDS = new Set([
  "a", "an", "and", "as", "at", "be", "by", "do", "for", "have",
  "i", "if", "in", "is", "it", "me", "my", "of", "on", "or", "so",
  "the", "to", "we", "you", "your", "what", "how", "why", "when",
  "where", "can", "could", "should", "would", "does", "did", "with",
]);
function tokenize(s: string): Set<string> {
  return new Set(
    normalizeQuestion(s)
      .split(/\s+/)
      .filter((w) => w.length > 1 && !STOP_WORDS.has(w)),
  );
}
export function wordJaccard(a: string, b: string): number {
  const ta = tokenize(a);
  const tb = tokenize(b);
  if (ta.size === 0 && tb.size === 0) return 0;
  let inter = 0;
  for (const w of ta) if (tb.has(w)) inter++;
  const union = ta.size + tb.size - inter;
  return union === 0 ? 0 : inter / union;
}

/* ------------------------------------------------------------------ */
/* DB layer                                                            */
/* ------------------------------------------------------------------ */

function surfaceFilter(surface: QASurface): string[] {
  /* A row tagged 'both' is valid for either surface. */
  return [surface, "both"];
}

async function findExactMatch(
  normalized: string,
  surface: QASurface,
): Promise<QARow | null> {
  if (!process.env.DATABASE_URL) return null;
  try {
    const r = await query<QARow>(
      `SELECT id, question_text, question_normalized, question_embedding,
              answer_text, source, ai_model, ai_generated_at, surface,
              helpful_count, not_helpful_count, lookup_count
         FROM knowledge_qa_entries
        WHERE question_normalized = $1
          AND surface = ANY($2::text[])
          AND NOT (not_helpful_count > $3 AND helpful_count = 0)
        ORDER BY lookup_count DESC, created_at DESC
        LIMIT 1`,
      [normalized, surfaceFilter(surface), AUTO_FLAG_NOT_HELPFUL],
    );
    return r.rows[0] ?? null;
  } catch (err) {
    getObsClient().recordError(err instanceof Error ? err : new Error(String(err)), {
      stage: "qa_cache.exact_match",
    });
    return null;
  }
}

async function loadCandidatesForSurface(surface: QASurface): Promise<QARow[]> {
  if (!process.env.DATABASE_URL) return [];
  try {
    const r = await query<QARow>(
      `SELECT id, question_text, question_normalized, question_embedding,
              answer_text, source, ai_model, ai_generated_at, surface,
              helpful_count, not_helpful_count, lookup_count
         FROM knowledge_qa_entries
        WHERE surface = ANY($1::text[])
          AND NOT (not_helpful_count > $2 AND helpful_count = 0)
        ORDER BY lookup_count DESC
        LIMIT 500`,
      [surfaceFilter(surface), AUTO_FLAG_NOT_HELPFUL],
    );
    return r.rows;
  } catch (err) {
    getObsClient().recordError(err instanceof Error ? err : new Error(String(err)), {
      stage: "qa_cache.load_candidates",
    });
    return [];
  }
}

async function bumpHit(qaId: string): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  try {
    await writeQuery(
      `UPDATE knowledge_qa_entries
          SET lookup_count = lookup_count + 1,
              last_used_at = NOW()
        WHERE id = $1`,
      [qaId],
      { expectRows: 1 },
    );
  } catch {
    /* Hit-counter bumps are best-effort; never block the caller. */
  }
}

async function insertAIGenerated(args: {
  questionText: string;
  normalized: string;
  embedding: number[] | null;
  embeddingModel: string | null;
  answer: string;
  surface: QASurface;
  aiModel: string;
  userId?: string;
}): Promise<string> {
  if (!process.env.DATABASE_URL) {
    /* Shadow mode — return a synthetic id so the response shape stays
       stable even when there's no DB to write into. */
    return `shadow-${Date.now()}`;
  }
  const embeddingPayload = args.embedding
    ? JSON.stringify({
        dim: args.embedding.length,
        model: args.embeddingModel ?? "unknown",
        vector: args.embedding,
      })
    : null;
  const r = await writeQuery<{ id: string }>(
    `INSERT INTO knowledge_qa_entries
       (question_text, question_normalized, question_embedding,
        answer_text, source, ai_model, ai_generated_at, surface,
        created_by_user_id)
     VALUES ($1, $2, $3::jsonb, $4, 'ai_generated', $5, NOW(), $6, $7)
     RETURNING id`,
    [
      args.questionText,
      args.normalized,
      embeddingPayload,
      args.answer,
      args.aiModel,
      args.surface,
      args.userId ?? null,
    ],
    { expectRows: 1 },
  );
  return r.rows[0]?.id ?? "";
}

/* ------------------------------------------------------------------ */
/* Feedback                                                            */
/* ------------------------------------------------------------------ */

export async function recordFeedback(qaId: string, helpful: boolean): Promise<void> {
  if (!process.env.DATABASE_URL) return;
  const col = helpful ? "helpful_count" : "not_helpful_count";
  await writeQuery(
    `UPDATE knowledge_qa_entries
        SET ${col} = ${col} + 1
      WHERE id = $1`,
    [qaId],
    { expectRows: 1 },
  );
}

/* ------------------------------------------------------------------ */
/* LLM fallback                                                        */
/* ------------------------------------------------------------------ */

const KNOWLEDGE_SYSTEM_PROMPT = `You are answering questions for the Wolfpack Agency team. You have access to internal documentation and runbooks. Be concise and direct (under 200 words). If you don't know, say so plainly — never invent. Cite the source when possible.`;

const ASSISTANT_SUPPORT_SYSTEM_PROMPT = `You are the Wolfpack Instinct support assistant. The wolfpack member asking has not yet filed a ticket — your job is to answer common questions so they can self-serve. If the question is unclear, ambiguous, or you do not have enough context to answer with confidence, say so explicitly and recommend they submit a support ticket. Be concise (under 200 words).`;

function pickSystemPrompt(surface: QASurface): string {
  return surface === "assistant_support"
    ? ASSISTANT_SUPPORT_SYSTEM_PROMPT
    : KNOWLEDGE_SYSTEM_PROMPT;
}

interface LLMOutcome {
  answer: string;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

async function callLLM(
  question: string,
  surface: QASurface,
  contextBlock = "",
): Promise<LLMOutcome> {
  const client = getAIClient();
  /* Prepend the SharePoint + MS Project grounding block to the system
     prompt. When contextBlock is empty (resolver failed, or user has no
     M365 token, or no hits), the prompt is unchanged. */
  const baseSystem = pickSystemPrompt(surface);
  const system = contextBlock
    ? `${contextBlock}\n${baseSystem}`
    : baseSystem;
  const result = await client.complete({
    messages: [{ role: "user", content: question }],
    system,
    max_tokens: 350,
    temperature: 0.2,
    model_tier: "cheap",
    sensitivity: "public",
    metadata: { feature: `knowledge.qa_cache.${surface}` },
  });
  return {
    answer: result.content.trim(),
    model: `${result.provider_used}/${result.model_used}`,
    promptTokens: result.input_tokens,
    completionTokens: result.output_tokens,
  };
}

/* ------------------------------------------------------------------ */
/* Public entry point                                                  */
/* ------------------------------------------------------------------ */

/**
 * The main lookup. See module doc for the full pipeline.
 *
 * Never throws on cache failures — every DB / embedding error falls
 * through to the LLM call so the user always gets an answer.
 */
export async function askWithCache(
  args: AskWithCacheArgs,
): Promise<AskWithCacheResult> {
  const startedAt = Date.now();
  const normalized = normalizeQuestion(args.question);
  if (!normalized) {
    throw new Error("question is required");
  }

  /* 1. Exact match fast path. */
  const exact = await findExactMatch(normalized, args.surface);
  if (exact) {
    void bumpHit(exact.id);
    return {
      qa_id: exact.id,
      answer: exact.answer_text,
      source: exact.source,
      ai_model: exact.ai_model,
      ai_generated_at: exact.ai_generated_at,
      was_cache_hit: true,
      similarity: 1,
      latency_ms: Date.now() - startedAt,
    };
  }

  /* 2. Embed + nearest neighbor. */
  let questionVec: number[] | null = null;
  let embeddingModel: string | null = null;
  if (isEmbeddingConfigured()) {
    try {
      const result = await embedBatch([normalized]);
      if (result && result.vectors[0]) {
        questionVec = result.vectors[0];
        embeddingModel = result.model;
      }
    } catch (err) {
      /* Embedding failures fall through to fallback scoring. */
      getObsClient().recordError(
        err instanceof Error ? err : new Error(String(err)),
        { stage: "qa_cache.embed" },
      );
    }
  }

  const candidates = await loadCandidatesForSurface(args.surface);
  if (candidates.length > 0) {
    let best: { row: QARow; score: number } | null = null;
    for (const row of candidates) {
      let score = 0;
      if (questionVec && row.question_embedding?.vector) {
        score = cosineSimilarity(questionVec, row.question_embedding.vector);
      } else {
        /* Fallback path — word-overlap Jaccard. */
        score = wordJaccard(normalized, row.question_normalized);
      }
      if (!best || score > best.score) best = { row, score };
    }
    const threshold = questionVec
      ? DEFAULT_SIM_THRESHOLD
      : FALLBACK_SIM_THRESHOLD;
    if (best && best.score >= threshold) {
      void bumpHit(best.row.id);
      return {
        qa_id: best.row.id,
        answer: best.row.answer_text,
        source: best.row.source,
        ai_model: best.row.ai_model,
        ai_generated_at: best.row.ai_generated_at,
        was_cache_hit: true,
        similarity: best.score,
        latency_ms: Date.now() - startedAt,
      };
    }
  }

  /* 3. Miss → LLM. Best-effort fetch of SharePoint + MS Project grounding
     so the answer is grounded in the team's internal documents. Failures
     here (403 scope_missing, Graph 5xx, missing OAuth token) MUST never
     block the LLM call — getRelevantContext emits its own typed analytics
     and the fallback is to answer ungrounded rather than 500. */
  let contextBlock = "";
  try {
    const ctx = await getRelevantContext({
      question: args.question,
      userId: args.userId ?? "",
      role: "" /* qa-cache doesn't carry role; resolver defaults to "user" */,
      surface: args.surface,
      maxChars: 6000,
    });
    contextBlock = ctx.rendered_prompt_block;
  } catch (err) {
    getObsClient().recordError(
      err instanceof Error ? err : new Error(String(err)),
      { stage: "qa_cache.context_resolve" },
    );
  }

  const outcome = await callLLM(args.question, args.surface, contextBlock);
  let qaId = "";
  try {
    qaId = await insertAIGenerated({
      questionText: args.question,
      normalized,
      embedding: questionVec,
      embeddingModel,
      answer: outcome.answer,
      surface: args.surface,
      aiModel: outcome.model,
      userId: args.userId,
    });
  } catch (err) {
    /* Cache write failure must not block the user — they still get the
       answer; the next identical question just burns tokens again. */
    getObsClient().recordError(
      err instanceof Error ? err : new Error(String(err)),
      { stage: "qa_cache.insert" },
    );
  }

  return {
    qa_id: qaId,
    answer: outcome.answer,
    source: "ai_generated",
    ai_model: outcome.model,
    ai_generated_at: new Date().toISOString(),
    was_cache_hit: false,
    latency_ms: Date.now() - startedAt,
    prompt_tokens: outcome.promptTokens,
    completion_tokens: outcome.completionTokens,
  };
}

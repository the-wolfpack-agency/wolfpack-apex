/**
 * Knowledge Base — Zero-token-first Q&A cache.
 *
 * Search PostgreSQL (pg_trgm) before calling AI.
 * If a cached answer with rating >= 3 exists, return it (zero tokens).
 * Every interaction feeds the learning loop via trackEvent().
 */

import { query, safeQuery } from "@/lib/db";
import { deniesCapability, capabilityDenialSql } from "@/lib/assistant/capability-denial";
import { trackEvent } from "@/lib/analytics";
import { tripleWriteKnowledge } from "@/lib/triple-write";
import { recordKnowledgeInteraction } from "@/lib/neo4j";

export interface KnowledgeEntry {
  id: string;
  question: string;
  answer: string;
  source: string;
  asked_by: string;
  repo?: string;
  file_path?: string;
  confidence: number;
  rating: number | null;
  view_count: number;
  tokens_used: number;
  tags: string[];
  created_at: string;
  updated_at: string;
  /** Postgres trigram similarity (0..1) between the search query and
   *  this entry's question, populated by `searchKnowledge`. Surfaced so
   *  callers can apply a quality threshold — the SQL floor of 0.1 is a
   *  "show me anything" floor, not an "answer this" floor. Absent for
   *  rows not retrieved via similarity search (e.g. demo entries). */
  sim?: number;
}

export interface KnowledgeGap {
  question: string;
  times_asked: number;
  last_asked: string;
}

// ---------------------------------------------------------------------------
// Shadow mode demo data
// ---------------------------------------------------------------------------
const DEMO_ENTRIES: KnowledgeEntry[] = [
  {
    id: "demo-k1",
    question: "How does the auth system work?",
    answer: "JWT-based auth with role hierarchy: cto > dev > ops > sales. Tokens expire after 8 hours.",
    source: "docs",
    asked_by: "demo-cto",
    confidence: 95,
    rating: 5,
    view_count: 12,
    tokens_used: 0,
    tags: ["auth", "security"],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
  {
    id: "demo-k2",
    question: "What database does Instinct use?",
    answer: "PostgreSQL with pg_trgm for full-text search and JSONB for flexible metadata storage.",
    source: "codebase",
    asked_by: "demo-dev",
    confidence: 90,
    rating: 4,
    view_count: 8,
    tokens_used: 0,
    tags: ["database", "infrastructure"],
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  },
];

// ---------------------------------------------------------------------------
// askQuestion — cache-first lookup
// ---------------------------------------------------------------------------
export async function askQuestion(
  question: string,
  userId: string,
  userRole: string,
  repo?: string,
): Promise<KnowledgeEntry | null> {
  trackEvent("knowledge.question_asked", userId, userRole, {
    question_length: question.length,
    repo: repo ?? "",
  });

  if (!process.env.DATABASE_URL) {
    const match = DEMO_ENTRIES.find(
      (e) =>
        e.question.toLowerCase().includes(question.toLowerCase()) ||
        question.toLowerCase().includes(e.question.toLowerCase().slice(0, 10)),
    );
    if (match) {
      trackEvent("knowledge.answer_found", userId, userRole, {
        knowledge_id: match.id,
        source: "cache",
        tokens_used: 0,
      });
      return match;
    }
    trackEvent("knowledge.answer_not_found", userId, userRole, {
      question_length: question.length,
    });
    return null;
  }

  try {
    const result = await query<Record<string, unknown>>(
      /* THE knowledge_cache PATH. This is the query that served "I cannot
         send emails directly" at zero tokens on 2026-08-28. A rating of 3+
         was treated as sufficient warrant, and somebody had rated a refusal
         well, presumably because it was polite. */
      `SELECT * FROM instinct_knowledge
       WHERE similarity(question, $1) > 0.3
         AND rating IS NOT NULL AND rating >= 3
         AND ${capabilityDenialSql("answer")}
       ORDER BY similarity(question, $1) DESC, view_count DESC
       LIMIT 1`,
      [question],
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      // Increment view_count
      await query(
        `UPDATE instinct_knowledge SET view_count = view_count + 1, updated_at = NOW() WHERE id = $1`,
        [row.id],
      );

      trackEvent("knowledge.answer_found", userId, userRole, {
        knowledge_id: row.id as string,
        source: "cache",
        tokens_used: 0,
      });

      // Fire-and-forget: record cache hit in Neo4j
      recordKnowledgeInteraction(userId, row.id as string, "ASKED", question).catch(() => {});

      return rowToKnowledge(row);
    }

    trackEvent("knowledge.answer_not_found", userId, userRole, {
      question_length: question.length,
    });
    return null;
  } catch (err) {
    console.error("[knowledge] askQuestion error:", (err as Error).message);
    trackEvent("knowledge.answer_not_found", userId, userRole, {
      question_length: question.length,
      error: true,
    });
    return null;
  }
}

// ---------------------------------------------------------------------------
// Don't cache obviously-wrong answers.
//
// An answer that describes a past event with a future date (e.g. "Your
// first recorded meeting was on June 4, 2026" said today, 2026-05-14)
// is a hallucination. If the cache stores it, every subsequent ask will
// reinforce the wrong answer. Defense-in-depth: refuse to cache.
//
// The check is narrow: we only veto when the answer matches a "past
// event" verb + a date string we can parse + that date is strictly
// later than today. Forward-looking copy ("scheduled for...") still
// caches fine.
// ---------------------------------------------------------------------------
const PAST_EVENT_VERB_RE =
  /\b(was|were|happened|occurred|took place|met|recorded|signed|closed|attended|joined|completed|finished|spoke|talked|discussed|reviewed|launched|shipped|published|fired|hired|left|departed)\b/i;
const DATE_IN_ANSWER_RE =
  /\b(?:Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:t(?:ember)?)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+\d{1,2}(?:,\s*\d{4})?\b/g;

function answerImpliesFuturePastEvent(answer: string, now = new Date()): boolean {
  if (!answer || !PAST_EVENT_VERB_RE.test(answer)) return false;
  const tomorrow = new Date(now);
  tomorrow.setUTCHours(0, 0, 0, 0);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  let m: RegExpExecArray | null;
  DATE_IN_ANSWER_RE.lastIndex = 0;
  while ((m = DATE_IN_ANSWER_RE.exec(answer))) {
    const parsed = Date.parse(m[0]);
    if (Number.isNaN(parsed)) continue;
    if (parsed >= tomorrow.getTime()) return true;
  }
  return false;
}

/* Low-confidence answers — "did you mean", "could you clarify", or
 * the AI's own self-warning that an answer "may need a second look /
 * mentions unfamiliar names". Caching these is actively harmful:
 * a 2026-05-24 incident saw a typo "insighta" produce a clarifying
 * AI response which then got served (via pg_trgm fuzzy match) to
 * every subsequent "insights" query as a zero-token "knowledge base"
 * hit. Reject upfront. */
const LOW_CONFIDENCE_PATTERNS = [
  /\bdid you mean\b/i,
  /\bcould you (please )?(clarify|provide more context|specify|elaborate)\b/i,
  /\bcan you (please )?(clarify|provide more context|specify|elaborate)\b/i,
  /\bmay need a second look\b/i,
  /\bunfamiliar names?\b/i,
  /\bnot sure (what|who|which) you('|')?re (referring to|asking about)\b/i,
  /\bi don('|')?t (have|see) (enough|any) (context|information) to/i,
];

function isLowConfidenceAnswer(answer: string): boolean {
  if (!answer) return false;
  return LOW_CONFIDENCE_PATTERNS.some((re) => re.test(answer));
}

// ---------------------------------------------------------------------------
// saveAnswer
// ---------------------------------------------------------------------------
export async function saveAnswer(
  question: string,
  answer: string,
  source: string,
  userId: string,
  repo?: string,
  filePath?: string,
  tokensUsed?: number,
): Promise<KnowledgeEntry | null> {
  // Reject answers that describe a past event with a future date — they're
  // hallucinations and caching them poisons every subsequent ask.
  if (answerImpliesFuturePastEvent(answer)) {
    trackEvent("knowledge.answer_rejected", userId, "dev", {
      reason: "past_event_future_date",
      source,
      tokens_used: tokensUsed ?? 0,
    });
    return null;
  }
  /* Reject an answer that denies a capability this product has. The clarifying
     filter below has caught "did you mean" since May and never considered that
     the model might refuse its own product, so that whole class was stored as
     fact and replayed at zero cost. See assistant/capability-denial.ts. */
  if (deniesCapability(answer)) {
    trackEvent("knowledge.answer_rejected", userId, "dev", {
      reason: "capability_denial",
      source,
      tokens_used: tokensUsed ?? 0,
    });
    return null;
  }
  // Reject low-confidence clarifying answers — see LOW_CONFIDENCE_PATTERNS.
  if (isLowConfidenceAnswer(answer)) {
    trackEvent("knowledge.answer_rejected", userId, "dev", {
      reason: "low_confidence_clarifying_answer",
      source,
      tokens_used: tokensUsed ?? 0,
    });
    return null;
  }
  if (!process.env.DATABASE_URL) {
    const entry: KnowledgeEntry = {
      id: `demo-${Date.now()}`,
      question,
      answer,
      source,
      asked_by: userId,
      repo,
      file_path: filePath,
      confidence: 0,
      rating: null,
      view_count: 0,
      tokens_used: tokensUsed ?? 0,
      tags: [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    return entry;
  }

  try {
    const result = await query<Record<string, unknown>>(
      `INSERT INTO instinct_knowledge (question, answer, source, asked_by, repo, file_path, tokens_used)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [question, answer, source, userId, repo ?? null, filePath ?? null, tokensUsed ?? 0],
    );

    const entry = rowToKnowledge(result.rows[0]);
    trackEvent("knowledge.answer_found", userId, "dev", {
      knowledge_id: entry.id,
      source,
      tokens_used: tokensUsed ?? 0,
    });

    // Fire-and-forget: triple-write to Qdrant + Neo4j
    tripleWriteKnowledge(
      entry.id, question, answer, source, userId, entry.tags, repo,
    ).catch(() => {});

    return entry;
  } catch (err) {
    console.error("[knowledge] saveAnswer error:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// updateAnswer — correct an existing entry and re-trigger triple-write.
//
// SQL uses COALESCE on source + tags so callers can pass undefined/null and
// leave those columns alone. Returns null when the WHERE clause matches no
// row, so the route layer can send a 404. Analytics fires
// `knowledge.entry_updated` with `{ knowledge_id, source }` on every real
// update — shadow mode fires the same event so the learning loop still
// picks it up in demo environments.
// ---------------------------------------------------------------------------
export async function updateAnswer(
  id: string,
  question: string,
  answer: string,
  userId: string,
  tags?: string[],
  source?: string,
): Promise<KnowledgeEntry | null> {
  if (!process.env.DATABASE_URL) {
    const entry: KnowledgeEntry = {
      id,
      question,
      answer,
      source: source ?? "human",
      asked_by: userId,
      confidence: 0,
      rating: null,
      view_count: 0,
      tokens_used: 0,
      tags: tags ?? [],
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    };
    trackEvent("knowledge.entry_updated", userId, "dev", {
      knowledge_id: id,
      source: entry.source,
    });
    return entry;
  }

  try {
    const result = await query<Record<string, unknown>>(
      `UPDATE instinct_knowledge
          SET question   = $2,
              answer     = $3,
              source     = COALESCE($4, source),
              tags       = COALESCE($5, tags),
              updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
      [id, question, answer, source ?? null, tags ?? null],
    );

    if (result.rows.length === 0) return null;

    const entry = rowToKnowledge(result.rows[0]);
    trackEvent("knowledge.entry_updated", userId, "dev", {
      knowledge_id: entry.id,
      source: entry.source,
    });
    return entry;
  } catch (err) {
    console.error("[knowledge] updateAnswer error:", (err as Error).message);
    return null;
  }
}

// ---------------------------------------------------------------------------
// deleteAnswer — hard delete. Soft-delete column doesn't exist on
// instinct_knowledge yet; if/when it does, swap to UPDATE SET deleted_at.
// Fires `knowledge.entry_deleted`. Returns true when a row was removed.
// ---------------------------------------------------------------------------
export async function deleteAnswer(
  id: string,
  userId: string,
): Promise<boolean> {
  if (!process.env.DATABASE_URL) {
    trackEvent("knowledge.entry_deleted", userId, "dev", { knowledge_id: id });
    return true;
  }

  try {
    const result = await query(
      `DELETE FROM instinct_knowledge WHERE id = $1`,
      [id],
    );
    const affected = (result as unknown as { rowCount?: number }).rowCount ?? 0;
    if (affected > 0) {
      trackEvent("knowledge.entry_deleted", userId, "dev", { knowledge_id: id });
      return true;
    }
    return false;
  } catch (err) {
    console.error("[knowledge] deleteAnswer error:", (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// rateAnswer
// ---------------------------------------------------------------------------
export async function rateAnswer(
  knowledgeId: string,
  rating: number,
  userId: string,
): Promise<boolean> {
  trackEvent("knowledge.answer_rated", userId, "dev", {
    knowledge_id: knowledgeId,
    rating,
  });

  if (!process.env.DATABASE_URL) return true;

  try {
    await query(
      `UPDATE instinct_knowledge SET rating = $1, updated_at = NOW() WHERE id = $2`,
      [rating, knowledgeId],
    );
    return true;
  } catch (err) {
    console.error("[knowledge] rateAnswer error:", (err as Error).message);
    return false;
  }
}

// ---------------------------------------------------------------------------
// getPopularQuestions
// ---------------------------------------------------------------------------
export async function getPopularQuestions(limit: number = 10): Promise<KnowledgeEntry[]> {
  if (!process.env.DATABASE_URL) return DEMO_ENTRIES;

  const { rows } = await safeQuery<Record<string, unknown>>(
    /* The Knowledge page, not the assistant. A refusal listed as a popular
       piece of knowledge is the same lie, printed somewhere a client browses
       at their leisure. */
    `SELECT * FROM instinct_knowledge
      WHERE ${capabilityDenialSql("answer")}
      ORDER BY view_count DESC LIMIT $1`,
    [limit],
  );
  return rows.map(rowToKnowledge);
}

/**
 * getRecentKnowledge — most recently created/updated entries first.
 * This is the default feed for the Knowledge page so an entry the
 * user just captured surfaces immediately, regardless of view_count.
 */
export async function getRecentKnowledge(
  limit: number = 50,
  offset: number = 0,
): Promise<KnowledgeEntry[]> {
  if (!process.env.DATABASE_URL) return DEMO_ENTRIES;

  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM instinct_knowledge
     WHERE ${capabilityDenialSql("answer")}
     ORDER BY COALESCE(updated_at, created_at) DESC
     LIMIT $1 OFFSET $2`,
    [limit, Math.max(0, offset)],
  );
  return rows.map(rowToKnowledge);
}

// ---------------------------------------------------------------------------
// getKnowledgeGaps
// ---------------------------------------------------------------------------
export async function getKnowledgeGaps(): Promise<KnowledgeGap[]> {
  if (!process.env.DATABASE_URL) {
    return [
      { question: "How do I deploy to production?", times_asked: 5, last_asked: new Date().toISOString() },
    ];
  }

  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT * FROM v_knowledge_gaps LIMIT 50`,
  );
  return rows.map((r) => ({
    question: r.question as string,
    times_asked: Number(r.times_asked),
    last_asked: String(r.last_asked),
  }));
}

// ---------------------------------------------------------------------------
// searchKnowledge
// ---------------------------------------------------------------------------
export async function searchKnowledge(
  searchQuery: string,
  limit: number = 10,
): Promise<KnowledgeEntry[]> {
  if (!process.env.DATABASE_URL) {
    return DEMO_ENTRIES.filter(
      (e) =>
        e.question.toLowerCase().includes(searchQuery.toLowerCase()) ||
        e.answer.toLowerCase().includes(searchQuery.toLowerCase()),
    );
  }

  /* Similarity threshold raised 2026-05-24 from 0.1 → 0.55.
   * pg_trgm at 0.1 was matching almost any pair of short queries
   * sharing a few letters — e.g. typo "insighta" + later real query
   * "insights" matched and served a cached "did you mean" answer
   * as if it were knowledge. 0.55 keeps near-duplicates (paraphrases,
   * plural/singular) while filtering out single-character typos and
   * unrelated short strings. The substring ILIKE branches are kept
   * because exact-substring matches are intentional ("vercel" finds
   * cached entries about Vercel) but bounded by 4+ chars to avoid
   * matching any random short token. */
  if (searchQuery.trim().length < 4) {
    /* Bare 1-3 char queries can't be searched usefully without
     * generating noise. Return empty; the LLM path will run. */
    return [];
  }
  /* NEVER SERVE A REFUSAL, WHATEVER IS IN THE TABLE.
     saveAnswer refuses to write one and migration 245 removed the sixteen
     already stored, and neither of those helps here. This is the read path,
     and it is the one that was actually serving them: measured 2026-08-28,
     "can you send an email for me" came back from this query, at zero tokens,
     with "I cannot send emails directly", which is false.
     
     Guarded on the read as well as the write because the two fixes protect
     against different things. The write filter stops tomorrow's poison; this
     stops anything already in the table, anything a restore puts back, and
     anything that arrives by a path neither of us has thought of. A cache is
     the wrong place to rely on a single control. */
  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT *, similarity(question, $1) AS sim
     FROM instinct_knowledge
     WHERE (
             similarity(question, $1) > 0.55
             OR question ILIKE '%' || $1 || '%'
             OR answer ILIKE '%' || $1 || '%'
           )
       AND ${capabilityDenialSql("answer")}
     ORDER BY sim DESC, view_count DESC
     LIMIT $2`,
    [searchQuery, limit],
  );
  return rows.map(rowToKnowledge);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function rowToKnowledge(row: Record<string, unknown>): KnowledgeEntry {
  return {
    id: row.id as string,
    question: row.question as string,
    answer: row.answer as string,
    source: row.source as string,
    asked_by: row.asked_by as string,
    repo: row.repo as string | undefined,
    file_path: row.file_path as string | undefined,
    confidence: Number(row.confidence ?? 0),
    rating: row.rating != null ? Number(row.rating) : null,
    view_count: Number(row.view_count ?? 0),
    tokens_used: Number(row.tokens_used ?? 0),
    tags: (row.tags as string[]) ?? [],
    created_at: String(row.created_at),
    updated_at: String(row.updated_at),
    sim: row.sim != null ? Number(row.sim) : undefined,
  };
}

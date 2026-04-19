/**
 * Knowledge Base — Zero-token-first Q&A cache.
 *
 * Search PostgreSQL (pg_trgm) before calling AI.
 * If a cached answer with rating >= 3 exists, return it (zero tokens).
 * Every interaction feeds the learning loop via trackEvent().
 */

import { query, safeQuery } from "@/lib/db";
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
      `SELECT * FROM apex_knowledge
       WHERE similarity(question, $1) > 0.3
         AND rating IS NOT NULL AND rating >= 3
       ORDER BY similarity(question, $1) DESC, view_count DESC
       LIMIT 1`,
      [question],
    );

    if (result.rows.length > 0) {
      const row = result.rows[0];
      // Increment view_count
      await query(
        `UPDATE apex_knowledge SET view_count = view_count + 1, updated_at = NOW() WHERE id = $1`,
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
      `INSERT INTO apex_knowledge (question, answer, source, asked_by, repo, file_path, tokens_used)
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
      `UPDATE apex_knowledge SET rating = $1, updated_at = NOW() WHERE id = $2`,
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
    `SELECT * FROM apex_knowledge ORDER BY view_count DESC LIMIT $1`,
    [limit],
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

  const { rows } = await safeQuery<Record<string, unknown>>(
    `SELECT *, similarity(question, $1) AS sim
     FROM apex_knowledge
     WHERE similarity(question, $1) > 0.1
        OR question ILIKE '%' || $1 || '%'
        OR answer ILIKE '%' || $1 || '%'
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
  };
}

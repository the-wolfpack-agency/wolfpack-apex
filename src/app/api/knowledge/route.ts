import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { askQuestion, saveAnswer, searchKnowledge, getPopularQuestions, getRecentKnowledge, getKnowledgeGaps } from "@/lib/knowledge";
import { tripleWriteKnowledge } from "@/lib/triple-write";

/**
 * GET /api/knowledge — Search knowledge base or list popular/gaps.
 *
 * Query params:
 *   ?q=search+term   — full-text search
 *   ?popular=true     — list by view_count
 *   ?gaps=true        — knowledge gaps view
 */
export async function GET(req: NextRequest) {
  const auth = await requireCapability(req, "knowledge.search");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const popular = url.searchParams.get("popular");
  const gaps = url.searchParams.get("gaps");
  const limit = Math.min(Math.max(Number(url.searchParams.get("limit") ?? 50), 1), 100);
  const offset = Math.max(Number(url.searchParams.get("offset") ?? 0), 0);

  trackEvent("system.search_performed", user.id, user.role, { module: "knowledge" });

  try {
    if (gaps === "true") {
      const data = await getKnowledgeGaps();
      return NextResponse.json({ gaps: data });
    }

    if (popular === "true") {
      const data = await getPopularQuestions(limit);
      return NextResponse.json({ entries: data });
    }

    if (q) {
      const data = await searchKnowledge(q, limit);
      return NextResponse.json({ entries: data, query: q });
    }

    // Default: most recent first so a freshly-captured entry is visible
    // without needing to wait for views to accumulate. Popular view is
    // still available via ?popular=true. Supports ?offset= for paging.
    const data = await getRecentKnowledge(limit, offset);
    return NextResponse.json({ entries: data, limit, offset });
  } catch (err) {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/knowledge — dual purpose.
 *
 *   Body shape A (ask):    { question: string, repo?: string }
 *     → returns cached answer or null (no persistence)
 *
 *   Body shape B (create): { question: string, answer: string,
 *                            source?: string, tags?: string[],
 *                            entry_id?: string, repo?: string }
 *     → persists to instinct_knowledge + triple-writes to Qdrant/Neo4j
 *       so the entry is immediately searchable by the assistant + RAG.
 *
 * Shape is detected by the presence of a non-empty `answer`. Required
 * capability `knowledge.create` gates the create path.
 */
export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const { question, answer, source, tags, repo } = body as {
      question?: string;
      answer?: string;
      source?: string;
      tags?: string[];
      entry_id?: string;
      repo?: string;
    };

    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    // --- Create path: has an answer → persist. ---
    if (typeof answer === "string" && answer.trim().length > 0) {
      // Any role with knowledge.search can also contribute entries;
      // capture is a non-destructive append and feeds the learning loop.
      const createAuth = await requireCapability(req, "knowledge.search");
      if (!createAuth.ok) return createAuth.response;
      const user = createAuth.user;

      const entry = await saveAnswer(
        question,
        answer,
        typeof source === "string" && source ? source : "human",
        user.id,
        repo,
        undefined,
        0,
      );

      if (!entry) {
        return NextResponse.json({ error: "Failed to persist entry" }, { status: 500 });
      }

      // Fire-and-forget triple-write so the assistant can retrieve this
      // entry via vector + graph stores without waiting on the response.
      void tripleWriteKnowledge(
        entry.id,
        question,
        answer,
        entry.source,
        user.id,
        Array.isArray(tags) ? tags.filter((t) => typeof t === "string") : [],
        repo,
      );

      trackEvent("knowledge.entry_created", user.id, user.role, {
        knowledge_id: entry.id,
        source: entry.source,
        tag_count: Array.isArray(tags) ? tags.length : 0,
      });

      return NextResponse.json({ ok: true, entry }, { status: 201 });
    }

    // --- Ask path: no answer → cache lookup. ---
    const askAuth = await requireCapability(req, "knowledge.search");
    if (!askAuth.ok) return askAuth.response;
    const askUser = askAuth.user;

    const cached = await askQuestion(question, askUser.id, askUser.role, repo);
    if (cached) {
      return NextResponse.json({ answer: cached, source: "cache", tokens_used: 0 });
    }
    return NextResponse.json({ answer: null, source: "none", tokens_used: 0 });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getUserFromRequest } from "@/lib/auth";
import { trackEvent } from "@/lib/analytics";
import { askQuestion, searchKnowledge, getPopularQuestions, getKnowledgeGaps } from "@/lib/knowledge";

/**
 * GET /api/knowledge — Search knowledge base or list popular/gaps.
 *
 * Query params:
 *   ?q=search+term   — full-text search
 *   ?popular=true     — list by view_count
 *   ?gaps=true        — knowledge gaps view
 */
export async function GET(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const url = new URL(req.url);
  const q = url.searchParams.get("q");
  const popular = url.searchParams.get("popular");
  const gaps = url.searchParams.get("gaps");
  const limit = Number(url.searchParams.get("limit") ?? 10);

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

    const data = await getPopularQuestions(limit);
    return NextResponse.json({ entries: data });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to search knowledge base", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

/**
 * POST /api/knowledge — Ask a question (cache-first).
 *
 * Body: { question: string, repo?: string }
 */
export async function POST(req: NextRequest) {
  const user = getUserFromRequest(req.headers.get("authorization"));
  if (!user) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  try {
    const body = await req.json();
    const { question, repo } = body as { question?: string; repo?: string };

    if (!question || typeof question !== "string") {
      return NextResponse.json({ error: "question is required" }, { status: 400 });
    }

    const cached = await askQuestion(question, user.id, user.role, repo);

    if (cached) {
      return NextResponse.json({ answer: cached, source: "cache", tokens_used: 0 });
    }

    return NextResponse.json({ answer: null, source: "none", tokens_used: 0 });
  } catch (err) {
    return NextResponse.json(
      { error: "Failed to process question", detail: (err as Error).message },
      { status: 500 },
    );
  }
}

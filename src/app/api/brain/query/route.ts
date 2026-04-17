/**
 * POST /api/brain/query — retrieval-only endpoint.
 *
 * Run the hybrid keyword + semantic search and return the hits without
 * calling any LLM. This is the Brain's read-path — the assistant uses
 * the same library (lib/brain/query.ts) but wraps the hits in a prompt
 * and calls Anthropic.
 *
 * Request body:
 *   { query: string, limit?: number, kind?: BrainKind, uploaded_by?: string }
 *
 * Response:
 *   { query, hits[], keyword_hits, semantic_hits, latency_ms, tokens_used,
 *     query_log_id }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { queryBrain } from "@/lib/brain/query";
import { rateLimitQuery } from "@/lib/brain/security";
import type { BrainKind } from "@/lib/brain/types";

const KINDS: BrainKind[] = ["pdf", "docx", "text", "markdown", "csv", "html", "audio", "video", "image", "email", "other"];

export async function POST(req: NextRequest) {
  const auth = await requireCapability(req, "brain.read");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  const rl = rateLimitQuery(user.id);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "rate_limited", retry_after_sec: rl.retryAfterSec },
      { status: 429, headers: { "Retry-After": String(rl.retryAfterSec ?? 60) } },
    );
  }

  let body: { query?: unknown; limit?: unknown; kind?: unknown; uploaded_by?: unknown; conversation_id?: unknown };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }

  const q = typeof body.query === "string" ? body.query.trim() : "";
  if (!q) {
    return NextResponse.json({ error: "query is required" }, { status: 400 });
  }
  if (q.length > 2000) {
    return NextResponse.json({ error: "query too long (max 2000 chars)" }, { status: 400 });
  }

  const limit = typeof body.limit === "number" ? body.limit : undefined;
  const kind =
    typeof body.kind === "string" && KINDS.includes(body.kind as BrainKind)
      ? (body.kind as BrainKind)
      : undefined;
  const uploadedBy = typeof body.uploaded_by === "string" && body.uploaded_by ? body.uploaded_by : undefined;
  const conversationId = typeof body.conversation_id === "string" ? body.conversation_id : null;

  const result = await queryBrain({
    userId: user.id,
    userRole: user.role,
    query: q,
    limit,
    kind,
    uploadedBy,
    conversationId,
  });

  return NextResponse.json(result);
}

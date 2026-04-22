import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { updateAnswer, deleteAnswer } from "@/lib/knowledge";
import { tripleWriteKnowledge } from "@/lib/triple-write";

/**
 * PUT /api/knowledge/[id] — correct an existing knowledge entry.
 *
 * Body: { question: string, answer: string, tags?: string[],
 *         source?: string, repo?: string }
 *
 * Re-triggers triple-write so Qdrant + Neo4j reflect the new content —
 * the embedding for this id is upserted, replacing the previous vector.
 *
 * Capability: `knowledge.search` — same loose gate as POST create; internal
 * contributions / corrections are low-risk and flow into the learning loop.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "knowledge.search");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const body = (await req.json()) as {
      question?: unknown;
      answer?: unknown;
      tags?: unknown;
      source?: unknown;
      repo?: unknown;
    };

    if (typeof body.question !== "string" || body.question.trim().length === 0) {
      return NextResponse.json(
        { error: "question is required" },
        { status: 400 },
      );
    }
    if (typeof body.answer !== "string" || body.answer.trim().length === 0) {
      return NextResponse.json(
        { error: "answer is required" },
        { status: 400 },
      );
    }

    const tags =
      Array.isArray(body.tags)
        ? (body.tags.filter((t) => typeof t === "string") as string[])
        : undefined;
    const source = typeof body.source === "string" ? body.source : undefined;
    const repo = typeof body.repo === "string" ? body.repo : undefined;

    const entry = await updateAnswer(
      id,
      body.question,
      body.answer,
      user.id,
      tags,
      source,
    );

    if (!entry) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    // Fire-and-forget: re-embed + re-link graph. Upsert on id replaces the
    // stale vector/rel, keeping the assistant's retrieval in sync with the
    // corrected PG row.
    void tripleWriteKnowledge(
      entry.id,
      body.question,
      body.answer,
      entry.source,
      user.id,
      tags ?? entry.tags,
      repo,
    );

    return NextResponse.json({ ok: true, entry }, { status: 200 });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/knowledge/[id] — remove a knowledge entry.
 *
 * Hard delete for now (instinct_knowledge has no deleted_at column).
 * Fires `knowledge.entry_deleted` for the learning loop.
 *
 * Capability: `knowledge.search` — parallel to PUT; low-risk internal
 * curation. Revisit when dedicated delete capability is introduced.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "knowledge.search");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const ok = await deleteAnswer(id, user.id);
    if (!ok) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }
    trackEvent("knowledge.entry_deleted", user.id, user.role, {
      knowledge_id: id,
    });
    return NextResponse.json({ ok: true, id }, { status: 200 });
  } catch {
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

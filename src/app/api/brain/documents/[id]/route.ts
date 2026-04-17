/**
 * GET /api/brain/documents/[id]   — document + chunks
 * DELETE /api/brain/documents/[id] — remove from Brain (PG + Qdrant)
 *
 * Delete is gated on `brain.manage` to prevent a non-admin user from
 * nuking a teammate's upload. Audit happens in the lib (repo.ts fires
 * brain.document_deleted trackEvent).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { deleteDocument, getChunksForDocument, getDocument } from "@/lib/brain/repo";
import { deleteByDocumentId } from "@/lib/brain/qdrant";

interface RouteCtx {
  params: Promise<{ id: string }>;
}

export async function GET(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireCapability(req, "brain.read");
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const doc = await getDocument(id);
  if (!doc) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Privacy: users see their own docs; manage capability sees others'.
  if (doc.uploaded_by !== auth.user.id) {
    const manage = await requireCapability(req, "brain.manage");
    if (!manage.ok) return manage.response;
  }

  const chunks = await getChunksForDocument(id);
  return NextResponse.json({ document: doc, chunks });
}

export async function DELETE(req: NextRequest, ctx: RouteCtx) {
  const auth = await requireCapability(req, "brain.manage");
  if (!auth.ok) return auth.response;

  const { id } = await ctx.params;
  if (!isUuid(id)) {
    return NextResponse.json({ error: "invalid id" }, { status: 400 });
  }

  const removed = await deleteDocument(id);
  if (!removed) return NextResponse.json({ error: "not_found" }, { status: 404 });

  // Best-effort Qdrant cleanup — a failure here leaves orphan points but
  // the collection's payload filter (document_id) means they're harmless
  // and a periodic reconciler can sweep them.
  deleteByDocumentId(id).catch(() => undefined);

  return NextResponse.json({ deleted: true, document_id: id });
}

function isUuid(s: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

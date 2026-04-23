import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import {
  downloadDocument,
  getDocuments,
  getDocumentById,
  updateDocument,
  deleteDocument,
} from "@/lib/doc-generator";
import { trackEvent } from "@/lib/analytics";
import { recordAudit, extractRequestMetadata } from "@/lib/audit-log";

/**
 * GET /api/docs/[id] — Get a single document.
 */
export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "docs.view");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const docs = await getDocuments();
    const doc = docs.find((d) => d.id === id);

    if (!doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    // IDOR check: only the document owner or a user with docs.edit
    // (workspace-level editing rights) can access someone else's doc.
    if (doc.generated_by !== user.id && !auth.capabilities.has("docs.edit")) {
      trackEvent("system.unauthorized_access_attempt", user.id, user.role, { resource: "doc", resource_id: id });
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    return NextResponse.json({ document: doc });
  } catch (err) {
    console.error("[docs/id]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * POST /api/docs/[id] — Download (increment counter).
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "docs.view");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const doc = await downloadDocument(id, user.id);

    if (!doc) {
      return NextResponse.json({ error: "Document not found" }, { status: 404 });
    }

    return NextResponse.json({ document: doc });
  } catch (err) {
    console.error("[docs/id/download]", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * PUT /api/docs/[id] — edit title / content / doc_type.
 *
 * Body: { title?: string, content?: string, doc_type?: string }
 *
 * Auth: the document's owner (generated_by) OR a user with `docs.edit`.
 * Increments revision on every successful update (via updateDocument).
 * Audit log + `docs.edited` event fire on success.
 */
export async function PUT(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "docs.view");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const existing = await getDocumentById(id);
    if (!existing) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const isOwner = existing.generated_by === user.id;
    const canEdit = auth.capabilities.has("docs.edit");
    if (!isOwner && !canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const body = (await req.json().catch(() => ({}))) as {
      title?: unknown;
      content?: unknown;
      doc_type?: unknown;
    };

    const title =
      typeof body.title === "string" && body.title.trim().length > 0
        ? body.title.trim()
        : undefined;
    const content = typeof body.content === "string" ? body.content : undefined;
    const doc_type =
      typeof body.doc_type === "string" ? body.doc_type : undefined;

    if (title === undefined && content === undefined && doc_type === undefined) {
      return NextResponse.json(
        { error: "at least one of title, content, doc_type required" },
        { status: 400 },
      );
    }

    const updated = await updateDocument(id, user.id, user.role, {
      title,
      content,
      doc_type,
    });
    if (!updated) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "docs.edited",
      resourceType: "document",
      resourceId: id,
      beforeState: existing,
      afterState: updated,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({ ok: true, document: updated }, { status: 200 });
  } catch (err) {
    console.error("[docs/id] PUT", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

/**
 * DELETE /api/docs/[id] — hard delete.
 *
 * Auth: owner OR `docs.edit`. Audit log + `docs.deleted` event on success.
 */
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "docs.view");
  if (!auth.ok) return auth.response;
  const user = auth.user;

  try {
    const { id } = await params;
    const existing = await getDocumentById(id);
    if (!existing) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const isOwner = existing.generated_by === user.id;
    const canEdit = auth.capabilities.has("docs.edit");
    if (!isOwner && !canEdit) {
      return NextResponse.json({ error: "forbidden" }, { status: 403 });
    }

    const ok = await deleteDocument(id, user.id, user.role);
    if (!ok) {
      return NextResponse.json({ error: "not found" }, { status: 404 });
    }

    const meta = extractRequestMetadata(req);
    await recordAudit({
      actor: { user_id: user.id, role: user.role },
      action: "docs.deleted",
      resourceType: "document",
      resourceId: id,
      beforeState: existing,
      afterState: null,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      requestId: meta.requestId,
    }).catch((e) => console.warn("[audit]", (e as Error).message));

    return NextResponse.json({ ok: true, id }, { status: 200 });
  } catch (err) {
    console.error("[docs/id] DELETE", (err as Error).message);
    return NextResponse.json(
      { error: "Internal server error" },
      { status: 500 },
    );
  }
}

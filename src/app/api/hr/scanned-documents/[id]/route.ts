/**
 * GET    /api/hr/scanned-documents/[id] — fetch one (view cap).
 * PATCH  /api/hr/scanned-documents/[id] — update fields/status (upload cap).
 * DELETE /api/hr/scanned-documents/[id] — delete (upload cap).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import { getHrDoc, patchHrDoc, deleteHrDoc } from "@/lib/hr/scanned-documents";

export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCapability(req, "hr.documents.view");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const row = await getHrDoc(auth.user.workspaceId, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ document: row });
}

export async function PATCH(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCapability(req, "hr.documents.upload");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = (await req.json().catch(() => null)) as Record<string, string | null> | null;
  if (!body) return NextResponse.json({ error: "body required" }, { status: 400 });

  const updated = await patchHrDoc({
    workspaceId: auth.user.workspaceId,
    id, changes: body,
    actorId: auth.user.id,
  });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const evt = body.status === "verified" ? "hr.document_verified"
    : body.status === "rejected" ? "hr.document_rejected"
    : "hr.document_updated";
  await trackEvent(evt, auth.user.id, auth.user.role, {
    document_id: id,
    doc_type: updated.doc_type,
    employee_email: updated.employee_email,
  });
  return NextResponse.json({ ok: true, document: updated });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireCapability(req, "hr.documents.upload");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const current = await getHrDoc(auth.user.workspaceId, id);
  if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });
  const ok = await deleteHrDoc(auth.user.workspaceId, id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await trackEvent("hr.document_deleted", auth.user.id, auth.user.role, {
    document_id: id, doc_type: current.doc_type, employee_email: current.employee_email,
  });
  return NextResponse.json({ ok: true });
}

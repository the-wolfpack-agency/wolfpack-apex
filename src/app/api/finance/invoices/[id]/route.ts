/**
 * GET    /api/finance/invoices/[id] — fetch one (view cap).
 * PATCH  /api/finance/invoices/[id] — update fields / status (manage cap).
 * DELETE /api/finance/invoices/[id] — soft-blocked: only paid/rejected
 *                                     can be deleted (manage cap).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireCapability } from "@/lib/auth/require-capability";
import { trackEvent } from "@/lib/analytics";
import {
  getInvoice,
  patchInvoice,
  deleteInvoice,
  type InvoiceStatus,
} from "@/lib/finance/invoices";

const VALID_STATUS_TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  pending: ["approved", "rejected"],
  approved: ["paid", "rejected", "pending"],
  paid: ["pending"], // unmarking a wrong "paid" — rare, kept for safety
  rejected: ["pending"],
};

export async function GET(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "finance.invoices.view");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const row = await getInvoice(auth.user.workspaceId, id);
  if (!row) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ invoice: row });
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "finance.invoices.manage");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = (await req.json().catch(() => null)) as Record<string, string | number | null> | null;
  if (!body || typeof body !== "object") {
    return NextResponse.json({ error: "body must be a JSON object" }, { status: 400 });
  }

  /* Status-transition guard. If status is in the patch, validate it's
     reachable from the current state — prevents finance accidentally
     setting status="paid" directly from "pending" without an approval
     step. */
  if (typeof body.status === "string") {
    const current = await getInvoice(auth.user.workspaceId, id);
    if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });
    const next = body.status as InvoiceStatus;
    const allowed = VALID_STATUS_TRANSITIONS[current.status] ?? [];
    if (!allowed.includes(next) && next !== current.status) {
      return NextResponse.json(
        { error: "invalid_status_transition", from: current.status, to: next, allowed },
        { status: 400 },
      );
    }
  }

  const updated = await patchInvoice({
    workspaceId: auth.user.workspaceId,
    id,
    changes: body,
    actorId: auth.user.id,
    actorEmail: auth.user.email ?? null,
  });
  if (!updated) return NextResponse.json({ error: "not_found" }, { status: 404 });

  /* Fire the right event based on status transition. */
  if (typeof body.status === "string") {
    const evt =
      body.status === "approved" ? "finance.invoice_approved"
        : body.status === "paid" ? "finance.invoice_paid"
        : body.status === "rejected" ? "finance.invoice_rejected"
        : "finance.invoice_updated";
    await trackEvent(evt, auth.user.id, auth.user.role, {
      invoice_id: id,
      vendor: updated.vendor_name ?? "",
      total: updated.total ?? 0,
    });
  } else {
    await trackEvent("finance.invoice_updated", auth.user.id, auth.user.role, {
      invoice_id: id,
      changed_keys: Object.keys(body).join(","),
    });
  }

  return NextResponse.json({ ok: true, invoice: updated });
}

export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireCapability(req, "finance.invoices.manage");
  if (!auth.ok) return auth.response;
  const { id } = await params;

  /* Don't allow deleting pending/approved invoices — they're still
     active financial records. Reject them first, then delete. */
  const current = await getInvoice(auth.user.workspaceId, id);
  if (!current) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (current.status === "pending" || current.status === "approved") {
    return NextResponse.json(
      { error: "cannot_delete_active", detail: `invoice status is "${current.status}"; reject it first` },
      { status: 409 },
    );
  }

  const ok = await deleteInvoice(auth.user.workspaceId, id);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  await trackEvent("finance.invoice_deleted", auth.user.id, auth.user.role, {
    invoice_id: id,
    vendor: current.vendor_name ?? "",
  });
  return NextResponse.json({ ok: true });
}

"use client";

/**
 * InvoicesPanel — list + upload + inline detail for the AP queue.
 *
 * One file holds the whole surface for v1: the upload button at top,
 * the status filter chips, the table, and an expandable detail panel
 * per row. Splits into separate components if it grows past ~600
 * lines.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

type InvoiceStatus = "pending" | "approved" | "paid" | "rejected";

interface InvoiceRow {
  id: string;
  uploaded_by_email: string | null;
  uploaded_at: string;
  original_filename: string | null;
  vendor_name: string | null;
  invoice_number: string | null;
  invoice_date: string | null;
  due_date: string | null;
  subtotal: string | null;
  tax: string | null;
  total: string | null;
  currency: string | null;
  status: InvoiceStatus;
  rejected_reason: string | null;
  notes: string | null;
  assigned_job_code: string | null;
  approved_by_email: string | null;
  approved_at: string | null;
  paid_at: string | null;
}

interface ListResponse {
  invoices: InvoiceRow[];
  count: number;
  status: string;
  counts: Record<InvoiceStatus, number>;
}

const STATUS_CHIPS: Array<{ key: InvoiceStatus | "all"; label: string }> = [
  { key: "pending", label: "Pending" },
  { key: "approved", label: "Approved" },
  { key: "paid", label: "Paid" },
  { key: "rejected", label: "Rejected" },
  { key: "all", label: "All" },
];

function fmtCurrency(amount: string | null, currency: string | null): string {
  if (amount == null || amount === "") return "—";
  const n = Number(amount);
  if (!Number.isFinite(n)) return amount;
  return `${currency ?? ""} ${n.toFixed(2)}`.trim();
}

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); }
  catch { return s; }
}

function ago(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

const STATUS_COLORS: Record<InvoiceStatus, { bg: string; fg: string; border: string }> = {
  pending: { bg: "rgba(234,179,8,0.12)", fg: "#eab308", border: "#eab308" },
  approved: { bg: "rgba(96,165,250,0.12)", fg: "#60a5fa", border: "#60a5fa" },
  paid: { bg: "rgba(74,222,128,0.12)", fg: "#4ade80", border: "#4ade80" },
  rejected: { bg: "rgba(248,113,113,0.12)", fg: "#f87171", border: "#f87171" },
};

export function InvoicesPanel() {
  const [invoices, setInvoices] = useState<InvoiceRow[]>([]);
  const [counts, setCounts] = useState<Record<InvoiceStatus, number>>({ pending: 0, approved: 0, paid: 0, rejected: 0 });
  const [statusFilter, setStatusFilter] = useState<InvoiceStatus | "all">("pending");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [actingId, setActingId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchWithRefresh("/api/me/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { capabilities?: string[] } | null) => {
        if (b?.capabilities?.includes("finance.invoices.manage")) setCanManage(true);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(`/api/finance/invoices?status=${statusFilter}`);
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as ListResponse;
      setInvoices(body.invoices ?? []);
      if (body.counts) setCounts(body.counts);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [statusFilter]);

  useEffect(() => { void load(); }, [load]);

  const handleFile = useCallback(async (file: File) => {
    setUploading(true);
    setUploadMsg(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchWithRefresh("/api/finance/invoices", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; cached?: boolean; invoice_id?: string; status?: InvoiceStatus; error?: string };
      if (!res.ok || !body.ok) {
        setUploadMsg(`Upload failed: ${body.error ?? `HTTP ${res.status}`}`);
        return;
      }
      /* Dedup hit: jump the filter chip to the existing row's status
         so the user actually SEES the row instead of being told it
         exists in some other tab they're not looking at. */
      if (body.cached && body.status && body.status !== statusFilter) {
        setStatusFilter(body.status);
        setUploadMsg(`Already in queue (status: ${body.status}) — re-opened. ${body.status === "rejected" ? "Use 'Re-open' to move it back to pending." : ""}`);
      } else if (body.cached) {
        setUploadMsg("Already in queue — opened existing entry");
      } else {
        setUploadMsg("Invoice queued — review below");
      }
      await load();
      if (body.invoice_id) setExpandedId(body.invoice_id);
    } catch (err) {
      setUploadMsg(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, [load]);

  const setStatus = useCallback(async (id: string, status: InvoiceStatus, extra: Record<string, string> = {}) => {
    setActingId(id);
    try {
      const res = await fetchWithRefresh(`/api/finance/invoices/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status, ...extra }),
      });
      if (!res.ok) {
        const b = (await res.json().catch(() => ({}))) as { error?: string };
        setError(b.error ?? `HTTP ${res.status}`);
        return;
      }
      await load();
    } finally {
      setActingId(null);
    }
  }, [load]);

  /* counts now sourced from the API (workspace-wide totals across
     ALL statuses, not just the currently-loaded filter). */


  return (
    <div className="space-y-3" data-testid="invoices-panel">
      <div className="flex flex-wrap items-center gap-2">
        {canManage && (
          <>
            <button
              type="button"
              data-testid="invoice-upload-trigger"
              onClick={() => inputRef.current?.click()}
              disabled={uploading}
              className="px-3 py-2 text-xs font-medium rounded"
              style={{
                background: uploading ? "var(--wp-dark-surface2, #1a1a1a)" : "var(--wp-gold, #eab308)",
                color: uploading ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark, #111)",
                border: "none",
                cursor: uploading ? "not-allowed" : "pointer",
              }}
            >
              {uploading ? "Reading invoice…" : "Upload invoice"}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept="image/jpeg,image/png,image/tiff,application/pdf,.pdf,.jpg,.jpeg,.png,.tif,.tiff"
              data-testid="invoice-upload-input"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) void handleFile(f);
                e.target.value = "";
              }}
            />
          </>
        )}
        <div className="flex flex-wrap gap-1" data-testid="invoice-status-chips">
          {STATUS_CHIPS.map((c) => (
            <button
              key={c.key}
              type="button"
              onClick={() => setStatusFilter(c.key)}
              data-testid={`invoice-status-chip-${c.key}`}
              className="px-2 py-1 text-xs rounded"
              style={{
                background: statusFilter === c.key ? "var(--wp-gold, #eab308)" : "var(--wp-dark-surface2, #1a1a1a)",
                color: statusFilter === c.key ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
                border: "1px solid var(--wp-dark-border, #333)",
                cursor: "pointer",
              }}
            >
              {c.label}{c.key !== "all" ? ` (${counts[c.key] ?? 0})` : ""}
            </button>
          ))}
        </div>
      </div>

      {uploadMsg && (
        <div
          data-testid="invoice-upload-message"
          className="text-xs rounded px-3 py-2"
          style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text-dim, #aaa)" }}
        >
          {uploadMsg}
        </div>
      )}

      {error && (
        <div
          data-testid="invoices-error"
          className="text-sm rounded px-3 py-2"
          style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }}
        >
          {error}
        </div>
      )}

      {loading && <div className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>Loading invoices…</div>}

      {!loading && invoices.length === 0 && !error && (
        <div data-testid="invoices-empty" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          {statusFilter === "all" ? "No invoices yet. Upload one to get started." : `No ${statusFilter} invoices.`}
        </div>
      )}

      {!loading && invoices.length > 0 && (
        <div className="rounded overflow-x-auto" style={{ border: "1px solid var(--wp-dark-border, #333)" }}>
          <table className="w-full text-sm">
            <thead style={{ background: "var(--wp-dark-surface2, #1a1a1a)" }}>
              <tr>
                {["Vendor", "Invoice #", "Date", "Due", "Total", "Status", "Uploaded"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 whitespace-nowrap" style={{ color: "var(--wp-text-dim, #aaa)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {invoices.map((r) => {
                const colors = STATUS_COLORS[r.status];
                const expanded = expandedId === r.id;
                return (
                  <>
                    <tr
                      key={r.id}
                      data-testid={`invoice-row-${r.id}`}
                      onClick={() => setExpandedId(expanded ? null : r.id)}
                      style={{ borderTop: "1px solid var(--wp-dark-border, #333)", cursor: "pointer" }}
                    >
                      <td className="px-3 py-2" style={{ color: "var(--wp-text, #eee)" }}>{r.vendor_name ?? "—"}</td>
                      <td className="px-3 py-2 font-mono text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>{r.invoice_number ?? "—"}</td>
                      <td className="px-3 py-2 text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>{fmtDate(r.invoice_date)}</td>
                      <td className="px-3 py-2 text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>{fmtDate(r.due_date)}</td>
                      <td className="px-3 py-2" style={{ color: "var(--wp-text, #eee)" }}>{fmtCurrency(r.total, r.currency)}</td>
                      <td className="px-3 py-2">
                        <span
                          data-testid={`invoice-status-${r.id}`}
                          className="rounded px-2 py-0.5 text-xs"
                          style={{ background: colors.bg, color: colors.fg, border: `1px solid ${colors.border}` }}
                        >
                          {r.status}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>{ago(r.uploaded_at)}</td>
                    </tr>
                    {expanded && (
                      <tr data-testid={`invoice-detail-${r.id}`}>
                        <td colSpan={7} className="px-3 py-3" style={{ background: "var(--wp-dark, #111)", borderTop: "1px solid var(--wp-dark-border, #333)" }}>
                          <div className="grid grid-cols-1 md:grid-cols-3 gap-3 text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                            <div><strong>Uploaded by:</strong> {r.uploaded_by_email ?? "—"}</div>
                            <div><strong>Subtotal:</strong> {fmtCurrency(r.subtotal, r.currency)}</div>
                            <div><strong>Tax:</strong> {fmtCurrency(r.tax, r.currency)}</div>
                            <div><strong>File:</strong> {r.original_filename ?? "—"}</div>
                            <div><strong>Approved by:</strong> {r.approved_by_email ?? "—"}</div>
                            <div><strong>Paid:</strong> {fmtDate(r.paid_at)}</div>
                            {r.rejected_reason && <div className="md:col-span-3"><strong>Rejected reason:</strong> {r.rejected_reason}</div>}
                            {r.notes && <div className="md:col-span-3"><strong>Notes:</strong> {r.notes}</div>}
                          </div>
                          {canManage && (
                            <div className="flex flex-wrap gap-2 mt-3" data-testid={`invoice-actions-${r.id}`}>
                              {r.status === "pending" && (
                                <>
                                  <button
                                    type="button"
                                    onClick={(e) => { e.stopPropagation(); void setStatus(r.id, "approved"); }}
                                    disabled={actingId === r.id}
                                    data-testid={`invoice-approve-${r.id}`}
                                    className="px-3 py-1.5 text-xs rounded font-medium"
                                    style={{ background: "#60a5fa", color: "#0b1220", border: "none", cursor: "pointer" }}
                                  >
                                    Approve
                                  </button>
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      const reason = prompt("Why reject this invoice?")?.trim();
                                      if (reason) void setStatus(r.id, "rejected", { rejected_reason: reason });
                                    }}
                                    disabled={actingId === r.id}
                                    data-testid={`invoice-reject-${r.id}`}
                                    className="px-3 py-1.5 text-xs rounded"
                                    style={{ background: "transparent", color: "#f87171", border: "1px solid #f87171", cursor: "pointer" }}
                                  >
                                    Reject
                                  </button>
                                </>
                              )}
                              {r.status === "approved" && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); void setStatus(r.id, "paid"); }}
                                  disabled={actingId === r.id}
                                  data-testid={`invoice-paid-${r.id}`}
                                  className="px-3 py-1.5 text-xs rounded font-medium"
                                  style={{ background: "#4ade80", color: "#0b1220", border: "none", cursor: "pointer" }}
                                >
                                  Mark paid
                                </button>
                              )}
                              {(r.status === "rejected" || r.status === "paid") && (
                                <button
                                  type="button"
                                  onClick={(e) => { e.stopPropagation(); void setStatus(r.id, "pending"); }}
                                  disabled={actingId === r.id}
                                  data-testid={`invoice-reopen-${r.id}`}
                                  className="px-3 py-1.5 text-xs rounded"
                                  style={{ background: "transparent", color: "var(--wp-gold, #eab308)", border: "1px solid var(--wp-gold, #eab308)", cursor: "pointer" }}
                                >
                                  Re-open
                                </button>
                              )}
                            </div>
                          )}
                        </td>
                      </tr>
                    )}
                  </>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

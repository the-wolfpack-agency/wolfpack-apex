"use client";

/**
 * InvoicesPanel — list + upload + inline detail for the AP queue.
 *
 * One file holds the whole surface for v1: the upload button at top,
 * the status filter chips, the table, and an expandable detail panel
 * per row. Splits into separate components if it grows past ~600
 * lines.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { fetchWithRefresh } from "@/lib/client-auth";

type InvoiceStatus = "pending" | "approved" | "paid" | "rejected";

/* Unified "Scan a document" router. The Invoice tab keeps PR #98's
   hero drop zone unchanged (same testids, same POST contract). The
   Receipt tab swaps to a parallel drop zone that POSTs to
   /api/job-codes/scan-receipt then bounces to /job-codes with a
   pending_scan param.

   Capability gate decision: both tabs sit behind
   finance.invoices.manage. Rationale — this surface lives at
   /finance/invoices, so "scan a document" reads as finance work to
   the user. The actual security boundary is the downstream POST
   (/api/job-codes/scan-receipt enforces jobcodes.refresh server-
   side); this client gate is for UX coherence. Splitting the tab
   gates would let a non-finance job-codes admin initiate scans on
   the finance page, which contradicts the surface's branding. */
type ScanMode = "invoice" | "receipt";

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
  const router = useRouter();
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
  const [isDragOver, setIsDragOver] = useState(false);
  const [scanMode, setScanMode] = useState<ScanMode>("invoice");
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

  /* Window-level drag listener so dragging a file ANYWHERE on the
     page lights up the drop zone — the modern-SaaS UX cue that says
     "I'm ready, just drop." Counter-tracked because dragenter/leave
     fire on every child element; only the (0,0) leave is the real
     "left the window" signal. */
  useEffect(() => {
    if (!canManage) return;
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        setIsDragOver(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.clientX === 0 && e.clientY === 0) setIsDragOver(false);
    };
    const onDrop = () => setIsDragOver(false);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [canManage]);

  /* Fire-and-forget analytics ping — never blocks the upload, never
     throws. Routed type + scan_id let the learning loop see WHICH
     intake surface the user chose and WHICH downstream resource the
     route produced. */
  const trackRoute = useCallback((type: ScanMode, scan_id: string) => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "system.scan_document_routed",
        metadata: { type, scan_id },
      }),
    }).catch(() => undefined);
  }, []);

  const handleInvoiceFile = useCallback(async (file: File) => {
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
      if (body.invoice_id) {
        setExpandedId(body.invoice_id);
        trackRoute("invoice", body.invoice_id);
      }
    } catch (err) {
      setUploadMsg(`Upload failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, [load, statusFilter, trackRoute]);

  const handleReceiptFile = useCallback(async (file: File) => {
    setUploading(true);
    setUploadMsg(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchWithRefresh("/api/job-codes/scan-receipt", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        scan_id?: string;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.ok || !body.scan_id) {
        const msg = body.detail ? `${body.error ?? `HTTP ${res.status}`}: ${body.detail}` : body.error ?? `HTTP ${res.status}`;
        setUploadMsg(`Receipt scan failed: ${msg}`);
        return;
      }
      trackRoute("receipt", body.scan_id);
      /* Bounce to /job-codes with the scan id so the existing apply
         modal (cascading picker + D/E/F writes + learning loop) takes
         over. The next page rehydrates from /api/job-codes/scan-
         receipt/<id> — no second Azure transaction. */
      router.push(`/job-codes?pending_scan=${encodeURIComponent(body.scan_id)}`);
    } catch (err) {
      setUploadMsg(`Receipt scan failed: ${(err as Error).message}`);
    } finally {
      setUploading(false);
    }
  }, [router, trackRoute]);

  const handleFile = useCallback(
    (file: File) => {
      if (scanMode === "receipt") return handleReceiptFile(file);
      return handleInvoiceFile(file);
    },
    [scanMode, handleInvoiceFile, handleReceiptFile],
  );

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
    <div className="space-y-4" data-testid="invoices-panel">
      {canManage ? (
        <div className="space-y-2" data-testid="scan-document-router">
          {/* Invoice / Receipt segmented toggle — same chip visual
              language as the status chips below so the controls read
              as one coherent set. Default: Invoice (preserves prior
              behavior for users who land here with muscle memory). */}
          <div className="flex gap-1" role="tablist" aria-label="Scan document type" data-testid="scan-mode-toggle">
            {(["invoice", "receipt"] as ScanMode[]).map((mode) => {
              const active = scanMode === mode;
              return (
                <button
                  key={mode}
                  type="button"
                  role="tab"
                  aria-selected={active}
                  data-testid={`scan-mode-${mode}`}
                  onClick={() => {
                    setScanMode(mode);
                    setUploadMsg(null);
                  }}
                  disabled={uploading}
                  className="px-3 py-1.5 text-xs rounded"
                  style={{
                    background: active ? "var(--wp-gold, #eab308)" : "var(--wp-dark-surface2, #1a1a1a)",
                    color: active ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
                    border: "1px solid var(--wp-dark-border, #333)",
                    cursor: uploading ? "not-allowed" : "pointer",
                    fontWeight: active ? 600 : 400,
                  }}
                >
                  {mode === "invoice" ? "Invoice" : "Receipt"}
                </button>
              );
            })}
          </div>

          {scanMode === "invoice" ? (
            /* Hero drop zone — Invoice variant. Unchanged from PR #98
               other than the file-handler dispatch (handleFile routes
               to handleInvoiceFile when scanMode === "invoice"). The
               whole zone is one giant <label> so native file-picker
               accessibility comes free (keyboard + screen reader
               treat it as the input's clickable label). */
            <label
              data-testid="invoice-upload-trigger"
              htmlFor="invoice-upload-input-el"
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragEnter={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) setIsDragOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragOver(false);
                const f = e.dataTransfer?.files?.[0];
                if (f && !uploading) void handleFile(f);
              }}
              className="block rounded-lg transition-all"
              style={{
                background: isDragOver
                  ? "rgba(234,179,8,0.10)"
                  : uploading
                    ? "var(--wp-dark-surface2, #1a1a1a)"
                    : "var(--wp-dark-surface, #151515)",
                border: `2px dashed ${isDragOver ? "var(--wp-gold, #eab308)" : uploading ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark-border, #333)"}`,
                cursor: uploading ? "wait" : "pointer",
                boxShadow: isDragOver ? "0 0 0 4px rgba(234,179,8,0.15)" : "none",
              }}
            >
              <input
                ref={inputRef}
                id="invoice-upload-input-el"
                type="file"
                accept="image/jpeg,image/png,image/tiff,application/pdf,.pdf,.jpg,.jpeg,.png,.tif,.tiff"
                data-testid="invoice-upload-input"
                style={{ display: "none" }}
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = "";
                }}
              />
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                {uploading ? (
                  <>
                    <svg
                      className="animate-spin"
                      width="36" height="36" viewBox="0 0 24 24" fill="none"
                      style={{ color: "var(--wp-gold, #eab308)" }}
                      aria-hidden
                    >
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                      <path d="M12 2 a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <div data-testid="scan-drop-headline" className="text-base font-semibold" style={{ color: "var(--wp-text, #eee)" }}>Reading invoice…</div>
                    <div data-testid="scan-drop-microcopy" className="text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                      Azure Document Intelligence is extracting vendor, amount, dates, and line items.
                    </div>
                  </>
                ) : (
                  <>
                    <svg
                      width="44" height="44" viewBox="0 0 24 24" fill="none"
                      style={{ color: isDragOver ? "var(--wp-gold, #eab308)" : "var(--wp-text-dim, #aaa)" }}
                      aria-hidden
                    >
                      <path d="M7 18a5 5 0 0 1-1-9.9V8a6 6 0 0 1 11.7-1.5A4.5 4.5 0 0 1 21 11.5c0 2.5-2 4.5-4.5 4.5H17"
                            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      <path d="M12 12v8m0-8-3 3m3-3 3 3"
                            stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                    <div data-testid="scan-drop-headline" className="text-lg font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
                      {isDragOver ? "Drop to upload" : "Upload an invoice"}
                    </div>
                    <div data-testid="scan-drop-microcopy" className="text-xs max-w-md" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                      Drop a PDF or photo here, or <span style={{ color: "var(--wp-gold, #eab308)", textDecoration: "underline" }}>click to browse</span>.
                      We&apos;ll extract vendor, amount, dates, and line items automatically.
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                      PDF · JPG · PNG · TIFF · up to 20 MB
                    </div>
                  </>
                )}
              </div>
            </label>
          ) : (
            /* Hero drop zone — Receipt variant. Parallel structure so
               every cue (drag-over, uploading spinner, native click-
               to-browse via <label>) carries over. Drop fires the
               receipt handler which POSTs to scan-receipt then
               router.pushes to /job-codes?pending_scan=<id>. */
            <label
              data-testid="receipt-upload-trigger"
              htmlFor="receipt-upload-input-el"
              onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragEnter={(e) => { e.preventDefault(); setIsDragOver(true); }}
              onDragLeave={(e) => {
                if (e.currentTarget === e.target) setIsDragOver(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragOver(false);
                const f = e.dataTransfer?.files?.[0];
                if (f && !uploading) void handleFile(f);
              }}
              className="block rounded-lg transition-all"
              style={{
                background: isDragOver
                  ? "rgba(234,179,8,0.10)"
                  : uploading
                    ? "var(--wp-dark-surface2, #1a1a1a)"
                    : "var(--wp-dark-surface, #151515)",
                border: `2px dashed ${isDragOver ? "var(--wp-gold, #eab308)" : uploading ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark-border, #333)"}`,
                cursor: uploading ? "wait" : "pointer",
                boxShadow: isDragOver ? "0 0 0 4px rgba(234,179,8,0.15)" : "none",
              }}
            >
              <input
                id="receipt-upload-input-el"
                type="file"
                accept="image/jpeg,image/png,image/tiff,image/bmp,application/pdf,.pdf,.jpg,.jpeg,.png,.tif,.tiff,.bmp"
                data-testid="receipt-upload-input"
                style={{ display: "none" }}
                disabled={uploading}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleFile(f);
                  e.target.value = "";
                }}
              />
              <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
                {uploading ? (
                  <>
                    <svg
                      className="animate-spin"
                      width="36" height="36" viewBox="0 0 24 24" fill="none"
                      style={{ color: "var(--wp-gold, #eab308)" }}
                      aria-hidden
                    >
                      <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" opacity="0.25" />
                      <path d="M12 2 a10 10 0 0 1 10 10" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
                    </svg>
                    <div data-testid="scan-drop-headline" className="text-base font-semibold" style={{ color: "var(--wp-text, #eee)" }}>Reading receipt…</div>
                    <div data-testid="scan-drop-microcopy" className="text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                      Azure Document Intelligence is extracting merchant, amount, and date.
                    </div>
                  </>
                ) : (
                  <>
                    <svg
                      width="44" height="44" viewBox="0 0 24 24" fill="none"
                      style={{ color: isDragOver ? "var(--wp-gold, #eab308)" : "var(--wp-text-dim, #aaa)" }}
                      aria-hidden
                    >
                      <path d="M4 2v20l3-2 3 2 3-2 3 2 3-2 3 2V2z"
                            stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                      <line x1="8" y1="7" x2="16" y2="7" stroke="currentColor" strokeWidth="1.8" />
                      <line x1="8" y1="11" x2="16" y2="11" stroke="currentColor" strokeWidth="1.8" />
                      <line x1="8" y1="15" x2="13" y2="15" stroke="currentColor" strokeWidth="1.8" />
                    </svg>
                    <div data-testid="scan-drop-headline" className="text-lg font-semibold" style={{ color: "var(--wp-text, #eee)" }}>
                      {isDragOver ? "Drop to upload" : "Upload a receipt"}
                    </div>
                    <div data-testid="scan-drop-microcopy" className="text-xs max-w-md" style={{ color: "var(--wp-text-dim, #aaa)" }}>
                      Drop a photo or PDF, or <span style={{ color: "var(--wp-gold, #eab308)", textDecoration: "underline" }}>click to browse</span>.
                      We&apos;ll extract merchant, amount, date — then you allocate to a job code.
                    </div>
                    <div className="text-[11px] mt-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                      PDF · JPG · PNG · TIFF · BMP · up to 3.5 MB
                    </div>
                  </>
                )}
              </div>
            </label>
          )}
        </div>
      ) : (
        /* Read-only callers see a clear "view only" hint instead of an
           invisible no-op so they understand the page's purpose. */
        <div
          data-testid="invoice-upload-readonly"
          className="rounded-lg px-4 py-3 text-xs"
          style={{
            background: "var(--wp-dark-surface, #151515)",
            border: "1px solid var(--wp-dark-border, #333)",
            color: "var(--wp-text-dim, #aaa)",
          }}
        >
          View only — upload requires the <strong>finance.invoices.manage</strong> capability.
          Ask an admin to grant it if you need to queue invoices.
        </div>
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

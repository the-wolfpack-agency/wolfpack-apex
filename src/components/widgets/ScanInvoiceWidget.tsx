"use client";

/**
 * ScanInvoiceWidget — assistant-side invoice intake.
 *
 * Drops an invoice (PDF or image) into the AP queue via
 * POST /api/finance/invoices. Server runs prebuilt-invoice and
 * persists with status='pending'. Returns a link to the queue.
 *
 * Capability-gated on finance.invoices.manage. Read-only callers
 * see a permission stub.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { ScanInvoiceWidgetSpec } from "@/lib/assistant/widgets/types";

interface ExtractedFields {
  vendorName: string | null;
  invoiceId: string | null;
  invoiceDate: string | null;
  dueDate: string | null;
  invoiceTotal: number | null;
  currency: string | null;
  lineItems: Array<{ description: string; amount: number | null }>;
  documentConfidence: number | null;
}

export interface ScanInvoiceWidgetProps {
  spec: ScanInvoiceWidgetSpec;
  workflowId?: string;
}

export function ScanInvoiceWidget({ spec: _spec, workflowId }: ScanInvoiceWidgetProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [fields, setFields] = useState<ExtractedFields | null>(null);
  const [invoiceId, setInvoiceId] = useState<string | null>(null);
  const [cached, setCached] = useState(false);

  const track = useCallback((action: string, value?: Record<string, unknown>) => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_interaction",
        metadata: { widget_kind: "scan_invoice", action, ...(value ?? {}), ...(workflowId ? { workflow_id: workflowId } : {}) },
      }),
    }).catch(() => undefined);
  }, [workflowId]);

  useEffect(() => {
    fetchWithRefresh("/api/me/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { capabilities?: string[] } | null) => {
        if (b?.capabilities?.includes("finance.invoices.manage")) setCanManage(true);
      })
      .catch(() => undefined);
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: { widget_kind: "scan_invoice", ...(workflowId ? { workflow_id: workflowId } : {}) },
      }),
    }).catch(() => undefined);
  }, [workflowId]);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setError(null);
    setFields(null);
    setInvoiceId(null);
    setCached(false);
    track("file_picked", { size: file.size, type: file.type });
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchWithRefresh("/api/finance/invoices", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean; cached?: boolean; invoice_id?: string; fields?: ExtractedFields; error?: string;
      };
      if (!res.ok || !body.ok || !body.invoice_id) {
        setError(body.error ?? `HTTP ${res.status}`);
        track("scan_failed", { reason: body.error ?? `http_${res.status}` });
        return;
      }
      setInvoiceId(body.invoice_id);
      setCached(!!body.cached);
      setFields(body.fields ?? null);
      track("scan_succeeded", { cached: !!body.cached, vendor: body.fields?.vendorName ?? "" });
    } catch (err) {
      setError((err as Error).message);
      track("scan_failed", { reason: "network_error" });
    } finally {
      setLoading(false);
    }
  }, [track]);

  if (!canManage) {
    return (
      <div
        data-testid="scan-invoice-widget"
        className="mt-2 rounded-md p-3 text-xs"
        style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text-dim, #aaa)" }}
      >
        Invoice upload requires finance.invoices.manage capability.
      </div>
    );
  }

  return (
    <div
      data-testid="scan-invoice-widget"
      className="mt-2 rounded-md p-3 space-y-3"
      style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)" }}
    >
      <div className="text-sm font-semibold" style={{ color: "var(--wp-text-dim, #aaa)" }}>
        Send invoice to AP queue
      </div>

      <button
        type="button"
        data-testid="scan-invoice-trigger"
        onClick={() => inputRef.current?.click()}
        disabled={loading}
        className="w-full px-3 py-2 text-xs font-medium rounded"
        style={{
          background: loading ? "var(--wp-dark, #111)" : "var(--wp-dark-surface2, #1a1a1a)",
          color: "var(--wp-text-dim, #aaa)",
          border: "1px dashed var(--wp-dark-border, #333)",
          cursor: loading ? "not-allowed" : "pointer",
        }}
      >
        {loading ? "Reading invoice…" : "Pick an invoice (PDF or image)"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/tiff,application/pdf,.pdf,.jpg,.jpeg,.png,.tif,.tiff"
        data-testid="scan-invoice-input"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />

      {error && (
        <div
          data-testid="scan-invoice-error"
          className="text-xs rounded px-2 py-1"
          style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }}
        >
          {error}
        </div>
      )}

      {fields && invoiceId && (
        <div
          data-testid="scan-invoice-summary"
          className="text-xs rounded p-2 space-y-1"
          style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)" }}
        >
          <div><strong>Vendor:</strong> {fields.vendorName ?? "—"}</div>
          <div><strong>Invoice #:</strong> {fields.invoiceId ?? "—"}</div>
          <div><strong>Date:</strong> {fields.invoiceDate ?? "—"}</div>
          <div><strong>Due:</strong> {fields.dueDate ?? "—"}</div>
          <div><strong>Total:</strong> {fields.invoiceTotal != null ? `${fields.currency ?? ""} ${fields.invoiceTotal}` : "—"}</div>
          <div><strong>Line items:</strong> {fields.lineItems.length}</div>
          {fields.documentConfidence != null && (
            <div style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              Confidence: {Math.round(fields.documentConfidence * 100)}%
            </div>
          )}
          <div className="pt-1" style={{ color: cached ? "var(--wp-text-muted, #6b7280)" : "#4ade80" }}>
            {cached ? "Already in queue (dedup)." : "Queued as pending — review on the Invoices page."}
          </div>
          <a
            href={`/finance/invoices`}
            data-testid="scan-invoice-open-queue"
            className="inline-block mt-1 underline"
            style={{ color: "var(--wp-gold, #eab308)" }}
          >
            Open invoice queue →
          </a>
        </div>
      )}
    </div>
  );
}

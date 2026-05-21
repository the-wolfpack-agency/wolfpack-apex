"use client";

/**
 * ScanReceiptWidget — assistant-side receipt scanner.
 *
 * Same end-to-end pipeline as the /job-codes ReceiptUploadButton:
 *   1. POST /api/job-codes/scan-receipt with the file bytes
 *   2. Surface extracted fields + a code picker
 *   3. User commits → PATCH /api/job-codes/[code]/cell for each
 *      non-empty field (only D/E/F per server allowlist)
 *   4. POST /api/job-codes/scan-receipt/[id]/apply records committed
 *      values for the learning loop
 *
 * Sized for inline chat rendering — compact dropzone + collapsible
 * extracted-summary card. Same capability gate as the page
 * (jobcodes.refresh); read-only callers see a "no edit permission"
 * stub instead of the dropzone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { ScanReceiptWidgetSpec } from "@/lib/assistant/widgets/types";

interface ReceiptItem {
  description: string;
  totalPrice: number | null;
  quantity: number | null;
}
interface ReceiptFields {
  merchantName: string | null;
  transactionDate: string | null;
  total: number | null;
  subtotal: number | null;
  tax: number | null;
  currency: string | null;
  items: ReceiptItem[];
  documentConfidence: number | null;
  rawText: string;
}

interface JobCodeRow {
  code: string;
  description: string;
}

export interface ScanReceiptWidgetProps {
  spec: ScanReceiptWidgetSpec;
  workflowId?: string;
}

export function ScanReceiptWidget({ spec, workflowId }: ScanReceiptWidgetProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [codes, setCodes] = useState<JobCodeRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [fields, setFields] = useState<ReceiptFields | null>(null);
  const [pickedCode, setPickedCode] = useState<string>(spec.jobCode ?? "");
  const [program, setProgram] = useState<string>("");
  const [poNumber, setPoNumber] = useState<string>("");
  const [poAmount, setPoAmount] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);

  const track = useCallback(
    (action: string, value?: Record<string, unknown>) => {
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "assistant.widget_interaction",
          metadata: {
            widget_kind: "scan_receipt",
            action,
            ...(value ?? {}),
            ...(workflowId ? { workflow_id: workflowId } : {}),
          },
        }),
      }).catch(() => undefined);
    },
    [workflowId],
  );

  /* Capability probe — hide the upload affordance for read-only
     users so they don't burn an Azure transaction on a 403. */
  useEffect(() => {
    fetchWithRefresh("/api/me/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { capabilities?: string[] } | null) => {
        if (body?.capabilities?.includes("jobcodes.refresh")) setCanEdit(true);
      })
      .catch(() => undefined);
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: { widget_kind: "scan_receipt", ...(workflowId ? { workflow_id: workflowId } : {}) },
      }),
    }).catch(() => undefined);
  }, [workflowId]);

  /* Pull the catalog so the code picker doesn't show empty even if
     the user hasn't visited /job-codes this session. */
  useEffect(() => {
    fetchWithRefresh("/api/job-codes")
      .then((r) => (r.ok ? r.json() : null))
      .then((body: { codes?: JobCodeRow[] } | null) => {
        if (body?.codes) {
          setCodes(body.codes.map((c) => ({ code: c.code, description: c.description })));
        }
      })
      .catch(() => undefined);
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setScanError(null);
    setApplyMessage(null);
    setFields(null);
    setScanId(null);
    track("file_picked", { size: file.size, type: file.type });
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchWithRefresh("/api/job-codes/scan-receipt", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        scan_id?: string;
        fields?: ReceiptFields;
        cached?: boolean;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.ok || !body.fields || !body.scan_id) {
        setScanError(body.error ?? `HTTP ${res.status}`);
        track("scan_failed", { reason: body.error ?? `http_${res.status}` });
        return;
      }
      setScanId(body.scan_id);
      setFields(body.fields);
      setPoAmount(body.fields.total != null ? String(body.fields.total) : "");
      setProgram("");
      setPoNumber("");
      track("scan_succeeded", { cached: !!body.cached, has_total: body.fields.total != null });
    } catch (err) {
      setScanError((err as Error).message);
      track("scan_failed", { reason: "network_error" });
    } finally {
      setLoading(false);
    }
  }, [track]);

  const handleApply = useCallback(async () => {
    if (!scanId || !pickedCode) return;
    setApplying(true);
    setApplyMessage(null);
    track("apply_started", { code: pickedCode });
    const writes: Array<Promise<{ ok: boolean; col: string; reason?: string }>> = [];
    const push = (col: "D" | "E" | "F", value: string, label: string) => {
      if (!value) return;
      writes.push(
        fetchWithRefresh(`/api/job-codes/${encodeURIComponent(pickedCode)}/cell`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ column: col, value }),
        }).then(async (res) => {
          const b = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
          return { ok: !!(res.ok && b.ok), col: label, reason: b.error };
        }),
      );
    };
    push("D", program, "Program");
    push("E", poNumber, "PO Number");
    push("F", poAmount, "PO Amount");
    const results = await Promise.all(writes);
    const failures = results.filter((r) => !r.ok);

    await fetchWithRefresh(`/api/job-codes/scan-receipt/${scanId}/apply`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        code: pickedCode,
        program: program || null,
        po_number: poNumber || null,
        po_amount: poAmount || null,
      }),
    }).catch(() => undefined);

    setApplying(false);
    if (failures.length === 0 && results.length > 0) {
      setApplyMessage(`Saved ${results.length} field${results.length === 1 ? "" : "s"} to ${pickedCode}`);
      track("apply_succeeded", { code: pickedCode, fields: results.length });
    } else if (results.length === 0) {
      setApplyMessage("Pick at least one field to save.");
    } else {
      setApplyMessage(
        `Saved ${results.length - failures.length}/${results.length} — failed: ${failures.map((f) => `${f.col} (${f.reason ?? "unknown"})`).join(", ")}`,
      );
      track("apply_partial_failure", { code: pickedCode, failures: failures.length });
    }
  }, [scanId, pickedCode, program, poNumber, poAmount, track]);

  const codeOptions = useMemo(() => codes, [codes]);

  if (!canEdit) {
    return (
      <div
        data-testid="scan-receipt-widget"
        className="mt-2 rounded-md p-3 text-xs"
        style={{
          background: "var(--wp-dark-surface2, #1a1a1a)",
          border: "1px solid var(--wp-dark-border, #333)",
          color: "var(--wp-text-dim, #aaa)",
        }}
      >
        Scan receipt requires admin role (jobcodes.refresh capability).
      </div>
    );
  }

  return (
    <div
      data-testid="scan-receipt-widget"
      className="mt-2 rounded-md p-3 space-y-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div className="text-sm font-semibold" style={{ color: "var(--wp-text-dim, #aaa)" }}>
        Scan a receipt
      </div>

      <button
        type="button"
        data-testid="scan-receipt-trigger"
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
        {loading ? "Reading receipt…" : "Pick a receipt (image or PDF)"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/tiff,image/bmp,application/pdf,.pdf,.jpg,.jpeg,.png,.tif,.tiff,.bmp"
        data-testid="scan-receipt-input"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />

      {scanError && (
        <div
          data-testid="scan-receipt-error"
          className="text-xs rounded px-2 py-1"
          style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }}
        >
          Scan failed: {scanError}
        </div>
      )}

      {fields && (
        <div className="space-y-2 text-xs" style={{ color: "var(--wp-text, #eee)" }}>
          <div
            data-testid="scan-receipt-summary"
            className="rounded p-2"
            style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)" }}
          >
            <div><strong>Merchant:</strong> {fields.merchantName ?? "—"}</div>
            <div><strong>Date:</strong> {fields.transactionDate ?? "—"}</div>
            <div><strong>Total:</strong> {fields.total != null ? `${fields.currency ?? ""} ${fields.total}` : "—"}</div>
            {fields.documentConfidence != null && (
              <div style={{ color: "var(--wp-text-muted, #6b7280)", marginTop: "0.25rem" }}>
                Confidence: {Math.round(fields.documentConfidence * 100)}%
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
              Apply to job code
            </label>
            <select
              value={pickedCode}
              onChange={(e) => setPickedCode(e.target.value)}
              data-testid="scan-receipt-code"
              className="w-full px-2 py-1.5 rounded"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
                color: "var(--wp-text, #eee)",
                fontSize: "16px",
              }}
            >
              <option value="" disabled>Choose a code…</option>
              {codeOptions.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.code}{c.description ? ` — ${c.description}` : ""}
                </option>
              ))}
            </select>
          </div>

          {[
            { label: "Program (D)", value: program, set: setProgram, testid: "scan-receipt-field-D" },
            { label: "PO Number (E)", value: poNumber, set: setPoNumber, testid: "scan-receipt-field-E" },
            { label: "PO Amount (F)", value: poAmount, set: setPoAmount, testid: "scan-receipt-field-F" },
          ].map((row) => (
            <div key={row.label}>
              <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                {row.label}
              </label>
              <input
                type="text"
                value={row.value}
                onChange={(e) => row.set(e.target.value)}
                data-testid={row.testid}
                placeholder="(leave blank to skip)"
                className="w-full px-2 py-1.5 rounded"
                style={{
                  background: "var(--wp-dark, #111)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  color: "var(--wp-text, #eee)",
                  fontSize: "16px",
                }}
              />
            </div>
          ))}

          {applyMessage && (
            <div
              data-testid="scan-receipt-apply-message"
              className="text-xs rounded px-2 py-1.5"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
                color: "var(--wp-text-dim, #aaa)",
              }}
            >
              {applyMessage}
            </div>
          )}

          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void handleApply()}
              disabled={!pickedCode || applying || (!program && !poNumber && !poAmount)}
              data-testid="scan-receipt-apply"
              className="px-3 py-1.5 rounded text-xs font-medium"
              style={{
                background: !pickedCode || applying ? "var(--wp-dark, #111)" : "var(--wp-gold, #eab308)",
                color: !pickedCode || applying ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
                cursor: !pickedCode || applying ? "not-allowed" : "pointer",
              }}
            >
              {applying ? "Applying…" : "Apply to SharePoint"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

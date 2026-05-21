"use client";

/**
 * ReceiptUploadButton — "📷 Scan receipt" affordance on /job-codes.
 *
 * Flow:
 *   1. User clicks → file picker opens (image/pdf only)
 *   2. POST /api/job-codes/scan-receipt with the file
 *   3. Modal renders the extracted fields (merchant, total, date,
 *      items)
 *   4. User picks a job code from a dropdown → confirms which of
 *      {Program, PO Number, PO Amount} to write
 *   5. For each chosen value, PATCH /api/job-codes/[code]/cell
 *   6. POST /api/job-codes/scan-receipt/[id]/apply to record the
 *      committed values for the learning loop
 *
 * Read-only callers don't see the button — same capability gate as
 * the inline cell edit (jobcodes.refresh).
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

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

interface JobCodeOption {
  code: string;
  description: string;
  /** Extra workbook columns keyed by header text. Used here to derive
   *  the Client/Category cascading filter. */
  extra: Record<string, string>;
}

const CATEGORY_HEADER = "Client/Category";

export interface ReceiptUploadButtonProps {
  canEdit: boolean;
  /** Full code records — needed for the Client/Category → Code
   *  cascading picker. */
  codeOptions: JobCodeOption[];
  /** Callback after successful apply — refresh the table. */
  onApplied?: () => void;
}

export function ReceiptUploadButton({ canEdit, codeOptions, onApplied }: ReceiptUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [scanError, setScanError] = useState<string | null>(null);
  const [scanId, setScanId] = useState<string | null>(null);
  const [fields, setFields] = useState<ReceiptFields | null>(null);
  /* Two-step picker: Client/Category narrows the Code list. */
  const [pickedCategory, setPickedCategory] = useState<string>("");
  const [pickedCode, setPickedCode] = useState<string>("");
  /* The user gets to override per-field before commit. Defaults
     pulled from the extraction — they can clear any of the three. */
  const [program, setProgram] = useState<string>("");
  const [poNumber, setPoNumber] = useState<string>("");
  const [poAmount, setPoAmount] = useState<string>("");
  const [applying, setApplying] = useState(false);
  const [applyMessage, setApplyMessage] = useState<string | null>(null);

  const reset = useCallback(() => {
    setOpen(false);
    setLoading(false);
    setScanError(null);
    setScanId(null);
    setFields(null);
    setPickedCategory("");
    setPickedCode("");
    setProgram("");
    setPoNumber("");
    setPoAmount("");
    setApplyMessage(null);
  }, []);

  const handleFile = useCallback(async (file: File) => {
    setLoading(true);
    setScanError(null);
    setApplyMessage(null);
    setOpen(true);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchWithRefresh("/api/job-codes/scan-receipt", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        scan_id?: string;
        fields?: ReceiptFields;
        error?: string;
        detail?: string;
      };
      if (!res.ok || !body.ok || !body.fields || !body.scan_id) {
        setScanError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      setScanId(body.scan_id);
      setFields(body.fields);
      /* Pre-populate the three form fields from the extraction so the
         user can review then commit with one click. */
      setPoAmount(body.fields.total != null ? String(body.fields.total) : "");
      /* No structured Program / PO Number from prebuilt-receipt — the
         user picks from the OCR rawText preview. Default to blank so
         they're forced to choose. */
      setProgram("");
      setPoNumber("");
    } catch (err) {
      setScanError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  const handleApply = useCallback(async () => {
    if (!scanId || !pickedCode) return;
    setApplying(true);
    setApplyMessage(null);
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

    /* Record the commit on the scan so future analytics can see what
       the user actually wrote (vs what the model returned). */
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
    if (failures.length === 0) {
      setApplyMessage(`Applied ${results.length} field${results.length === 1 ? "" : "s"} to ${pickedCode}`);
      onApplied?.();
      window.setTimeout(reset, 1500);
    } else {
      setApplyMessage(
        `Saved ${results.length - failures.length}/${results.length} — failed: ${failures.map((f) => `${f.col} (${f.reason ?? "unknown"})`).join(", ")}`,
      );
    }
  }, [scanId, pickedCode, program, poNumber, poAmount, onApplied, reset]);

  /* Distinct Client/Category values, alphabetized. Codes without a
     value still surface under "(no category)" so they're reachable. */
  const categoryChoices = useMemo(() => {
    const set = new Set<string>();
    for (const c of codeOptions) {
      const v = (c.extra?.[CATEGORY_HEADER] ?? "").trim();
      set.add(v || "(no category)");
    }
    return [...set].sort();
  }, [codeOptions]);

  /* Codes filtered by the chosen category. */
  const codeChoices = useMemo(() => {
    if (!pickedCategory) return [];
    return codeOptions
      .filter((c) => {
        const v = (c.extra?.[CATEGORY_HEADER] ?? "").trim();
        if (pickedCategory === "(no category)") return !v;
        return v === pickedCategory;
      })
      .sort((a, b) => a.code.localeCompare(b.code));
  }, [codeOptions, pickedCategory]);

  if (!canEdit) return null;

  return (
    <>
      <button
        type="button"
        data-testid="receipt-upload-trigger"
        onClick={() => inputRef.current?.click()}
        className="px-3 py-2 text-xs font-medium rounded"
        style={{
          background: "var(--wp-dark-surface2, #1a1a1a)",
          color: "var(--wp-text-dim, #aaa)",
          border: "1px solid var(--wp-dark-border, #333)",
          cursor: "pointer",
        }}
      >
        Scan receipt
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/tiff,image/bmp,application/pdf,.pdf,.jpg,.jpeg,.png,.tif,.tiff,.bmp"
        data-testid="receipt-upload-input"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />

      {open && (
        <div
          role="dialog"
          aria-label="Scan receipt"
          data-testid="receipt-upload-modal"
          className="fixed inset-0 flex items-center justify-center z-50"
          onClick={reset}
        >
          <div className="absolute inset-0 bg-black/60" />
          <div
            onClick={(e) => e.stopPropagation()}
            className="relative w-full max-w-md p-5 rounded-lg space-y-3"
            style={{
              background: "var(--wp-dark-surface, #1f1f22)",
              border: "1px solid var(--wp-dark-border, #333)",
              color: "var(--wp-text, #eee)",
              maxHeight: "85vh",
              overflowY: "auto",
            }}
          >
            <h2 style={{ margin: 0, fontSize: "1rem", color: "var(--wp-gold)" }}>
              Scan receipt
            </h2>

            {loading && (
              <p data-testid="receipt-upload-loading" style={{ fontSize: "0.85rem", color: "var(--wp-text-dim, #aaa)" }}>
                Reading receipt via Azure Document Intelligence…
              </p>
            )}

            {scanError && !loading && (
              <p data-testid="receipt-upload-error" style={{ fontSize: "0.85rem", color: "#f87171" }}>
                Scan failed: {scanError}
              </p>
            )}

            {fields && !loading && (
              <div className="space-y-3 text-xs">
                <div
                  data-testid="receipt-extracted-summary"
                  className="rounded p-2"
                  style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)" }}
                >
                  <div><strong>Merchant:</strong> {fields.merchantName ?? "—"}</div>
                  <div><strong>Date:</strong> {fields.transactionDate ?? "—"}</div>
                  <div><strong>Total:</strong> {fields.total != null ? `${fields.currency ?? ""} ${fields.total}` : "—"}</div>
                  <div><strong>Items:</strong> {fields.items.length}</div>
                  {fields.documentConfidence != null && (
                    <div style={{ color: "var(--wp-text-muted, #6b7280)", marginTop: "0.25rem" }}>
                      Confidence: {Math.round(fields.documentConfidence * 100)}%
                    </div>
                  )}
                </div>

                <div>
                  <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                    Client / Category
                  </label>
                  <select
                    value={pickedCategory}
                    onChange={(e) => {
                      setPickedCategory(e.target.value);
                      setPickedCode("");
                    }}
                    data-testid="receipt-category-picker"
                    className="w-full px-2 py-1.5 rounded"
                    style={{
                      background: "var(--wp-dark, #111)",
                      border: "1px solid var(--wp-dark-border, #333)",
                      color: "var(--wp-text, #eee)",
                      fontSize: "16px",
                    }}
                  >
                    <option value="" disabled>Choose a client / category…</option>
                    {categoryChoices.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>

                {pickedCategory && (
                  <div>
                    <label className="block text-xs mb-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
                      Job Code ({codeChoices.length})
                    </label>
                    <select
                      value={pickedCode}
                      onChange={(e) => setPickedCode(e.target.value)}
                      data-testid="receipt-code-picker"
                      className="w-full px-2 py-1.5 rounded"
                      style={{
                        background: "var(--wp-dark, #111)",
                        border: "1px solid var(--wp-dark-border, #333)",
                        color: "var(--wp-text, #eee)",
                        fontSize: "16px",
                      }}
                    >
                      <option value="" disabled>Choose a code…</option>
                      {codeChoices.map((c) => (
                        <option key={c.code} value={c.code}>
                          {c.code}{c.description ? ` — ${c.description}` : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                )}

                <div className="grid grid-cols-1 gap-2">
                  {[
                    { label: "Program (D)", value: program, set: setProgram, testid: "receipt-field-program" },
                    { label: "PO Number (E)", value: poNumber, set: setPoNumber, testid: "receipt-field-po-number" },
                    { label: "PO Amount (F)", value: poAmount, set: setPoAmount, testid: "receipt-field-po-amount" },
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
                </div>

                {applyMessage && (
                  <div
                    data-testid="receipt-apply-message"
                    className="text-xs rounded px-2 py-1.5"
                    style={{
                      background: "var(--wp-dark-surface2, #1a1a1a)",
                      border: "1px solid var(--wp-dark-border, #333)",
                      color: "var(--wp-text-dim, #aaa)",
                    }}
                  >
                    {applyMessage}
                  </div>
                )}

                <div className="flex justify-end gap-2">
                  <button
                    type="button"
                    onClick={reset}
                    data-testid="receipt-cancel"
                    className="px-3 py-1.5 rounded text-xs"
                    style={{ background: "var(--wp-dark-surface2, #1a1a1a)", color: "var(--wp-text-dim, #aaa)", border: "1px solid var(--wp-dark-border, #333)", cursor: "pointer" }}
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleApply()}
                    disabled={!pickedCode || applying || (!program && !poNumber && !poAmount)}
                    data-testid="receipt-apply"
                    className="px-3 py-1.5 rounded text-xs font-medium"
                    style={{
                      background: !pickedCode || applying ? "var(--wp-dark, #111)" : "var(--wp-gold, #eab308)",
                      color: !pickedCode || applying ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark, #111)",
                      border: "1px solid var(--wp-dark-border, #333)",
                      cursor: !pickedCode || applying ? "not-allowed" : "pointer",
                    }}
                  >
                    {applying ? "Applying…" : "Apply to job code"}
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}

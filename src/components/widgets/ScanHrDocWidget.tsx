"use client";

/**
 * ScanHrDocWidget — assistant-surface HR doc intake. Drop a license,
 * passport, W-2, W-9, I-9, voided check, etc. for a specific
 * employee → server picks the right extractor (Form Recognizer for
 * IDs; Computer Vision OCR fallback for tax forms / banking) → row
 * lands in /hr/documents queue.
 *
 * Capability: hr.documents.upload (HR / CEO / CTO / EVP).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { ScanHrDocWidgetSpec } from "@/lib/assistant/widgets/types";

const DOC_TYPES = [
  { v: "license", l: "Driver's License" },
  { v: "passport", l: "Passport" },
  { v: "state_id", l: "State ID" },
  { v: "w2", l: "W-2" },
  { v: "w4", l: "W-4" },
  { v: "w9", l: "W-9" },
  { v: "i9", l: "I-9" },
  { v: "voided_check", l: "Voided Check" },
  { v: "direct_deposit", l: "Direct Deposit Form" },
  { v: "other", l: "Other" },
];

export interface ScanHrDocWidgetProps {
  spec: ScanHrDocWidgetSpec;
  workflowId?: string;
}

export function ScanHrDocWidget({ spec, workflowId }: ScanHrDocWidgetProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [canUpload, setCanUpload] = useState(false);
  const [employee, setEmployee] = useState(spec.employeeEmail ?? "");
  const [name, setName] = useState("");
  const [docType, setDocType] = useState(spec.docType ?? "license");
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [resultId, setResultId] = useState<string | null>(null);

  useEffect(() => {
    fetchWithRefresh("/api/me/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { capabilities?: string[] } | null) => {
        if (b?.capabilities?.includes("hr.documents.upload")) setCanUpload(true);
      })
      .catch(() => undefined);
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: { widget_kind: "scan_hr_doc", ...(workflowId ? { workflow_id: workflowId } : {}) },
      }),
    }).catch(() => undefined);
  }, [workflowId]);

  const handleFile = useCallback(async (file: File) => {
    if (!employee.trim()) { setError("Set the employee email first."); return; }
    setLoading(true); setError(null); setMsg(null); setResultId(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("employee_email", employee.trim().toLowerCase());
      if (name.trim()) form.append("employee_name", name.trim());
      form.append("doc_type", docType);
      const res = await fetchWithRefresh("/api/hr/scanned-documents", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; cached?: boolean; document_id?: string; error?: string; blocked_by?: string[] };
      if (!res.ok || !body.ok) {
        const blocked = body.blocked_by?.length ? ` (${body.blocked_by.join(", ")})` : "";
        setError(`${body.error ?? `HTTP ${res.status}`}${blocked}`);
        return;
      }
      setResultId(body.document_id ?? null);
      setMsg(body.cached ? "Already in queue (dedup)." : "Saved — review on /hr/documents.");
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setLoading(false);
    }
  }, [employee, name, docType]);

  if (!canUpload) {
    return (
      <div
        data-testid="scan-hr-doc-widget"
        className="mt-2 rounded-md p-3 text-xs"
        style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text-dim, #aaa)" }}
      >
        HR document upload requires hr.documents.upload capability.
      </div>
    );
  }

  return (
    <div
      data-testid="scan-hr-doc-widget"
      className="mt-2 rounded-md p-3 space-y-2"
      style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)" }}
    >
      <div className="text-sm font-semibold" style={{ color: "var(--wp-text-dim, #aaa)" }}>Send HR document</div>

      <input
        type="email"
        value={employee}
        onChange={(e) => setEmployee(e.target.value)}
        placeholder="Employee email (required)"
        data-testid="scan-hr-doc-email"
        className="w-full px-2 py-1.5 rounded text-xs"
        style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)", fontSize: "16px" }}
      />
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="Employee name (optional)"
        data-testid="scan-hr-doc-name"
        className="w-full px-2 py-1.5 rounded text-xs"
        style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)", fontSize: "16px" }}
      />
      <select
        value={docType}
        onChange={(e) => setDocType(e.target.value)}
        data-testid="scan-hr-doc-type"
        className="w-full px-2 py-1.5 rounded text-xs"
        style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)", fontSize: "16px" }}
      >
        {DOC_TYPES.map((d) => <option key={d.v} value={d.v}>{d.l}</option>)}
      </select>

      <button
        type="button"
        data-testid="scan-hr-doc-trigger"
        onClick={() => inputRef.current?.click()}
        disabled={loading || !employee.trim()}
        className="w-full px-3 py-2 text-xs font-medium rounded"
        style={{
          background: loading || !employee.trim() ? "var(--wp-dark, #111)" : "var(--wp-dark-surface2, #1a1a1a)",
          color: "var(--wp-text-dim, #aaa)",
          border: "1px dashed var(--wp-dark-border, #333)",
          cursor: loading || !employee.trim() ? "not-allowed" : "pointer",
        }}
      >
        {loading ? "Reading…" : "Pick file (image or PDF)"}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/tiff,application/pdf,.pdf,.jpg,.jpeg,.png,.tif,.tiff"
        data-testid="scan-hr-doc-input"
        style={{ display: "none" }}
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void handleFile(f);
          e.target.value = "";
        }}
      />

      {error && (
        <div data-testid="scan-hr-doc-error" className="text-xs rounded px-2 py-1" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }}>
          {error}
        </div>
      )}
      {msg && resultId && (
        <div data-testid="scan-hr-doc-message" className="text-xs rounded px-2 py-1" style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text-dim, #aaa)" }}>
          {msg} <a href="/hr/documents" className="underline" style={{ color: "var(--wp-gold, #eab308)" }}>Open queue →</a>
        </div>
      )}
    </div>
  );
}

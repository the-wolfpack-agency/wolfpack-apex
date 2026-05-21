"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

type HrDocType = "license" | "passport" | "state_id" | "w2" | "w4" | "w9" | "i9" | "voided_check" | "direct_deposit" | "other";
type HrDocStatus = "pending" | "verified" | "rejected" | "expired";

interface HrDocRow {
  id: string;
  uploaded_at: string;
  original_filename: string | null;
  employee_email: string;
  employee_name: string | null;
  doc_type: HrDocType;
  document_number: string | null;
  document_expiry: string | null;
  full_name: string | null;
  status: HrDocStatus;
  rejected_reason: string | null;
  notes: string | null;
  uploaded_by_email: string | null;
  verified_at: string | null;
}

const DOC_TYPE_LABELS: Record<HrDocType, string> = {
  license: "Driver's License", passport: "Passport", state_id: "State ID",
  w2: "W-2", w4: "W-4", w9: "W-9", i9: "I-9",
  voided_check: "Voided Check", direct_deposit: "Direct Deposit Form", other: "Other",
};

const STATUS_COLORS: Record<HrDocStatus, { bg: string; fg: string; border: string }> = {
  pending: { bg: "rgba(234,179,8,0.12)", fg: "#eab308", border: "#eab308" },
  verified: { bg: "rgba(74,222,128,0.12)", fg: "#4ade80", border: "#4ade80" },
  rejected: { bg: "rgba(248,113,113,0.12)", fg: "#f87171", border: "#f87171" },
  expired: { bg: "rgba(156,163,175,0.12)", fg: "#9ca3af", border: "#9ca3af" },
};

function fmtDate(s: string | null): string {
  if (!s) return "—";
  try { return new Date(s).toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" }); }
  catch { return s; }
}

export function HrDocsPanel() {
  const [docs, setDocs] = useState<HrDocRow[]>([]);
  const [statusFilter, setStatusFilter] = useState<HrDocStatus | "all">("all");
  const [employeeFilter, setEmployeeFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [canUpload, setCanUpload] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [uploadMsg, setUploadMsg] = useState<string | null>(null);
  /* Upload form state */
  const [pickedEmployee, setPickedEmployee] = useState("");
  const [pickedName, setPickedName] = useState("");
  const [pickedDocType, setPickedDocType] = useState<HrDocType>("license");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetchWithRefresh("/api/me/capabilities")
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { capabilities?: string[] } | null) => {
        if (b?.capabilities?.includes("hr.documents.upload")) setCanUpload(true);
      })
      .catch(() => undefined);
  }, []);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (statusFilter !== "all") params.set("status", statusFilter);
      if (employeeFilter.trim()) params.set("employee_email", employeeFilter.trim().toLowerCase());
      const res = await fetchWithRefresh(`/api/hr/scanned-documents?${params}`);
      if (!res.ok) {
        setError((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`);
        return;
      }
      const body = (await res.json()) as { documents: HrDocRow[] };
      setDocs(body.documents ?? []);
    } finally {
      setLoading(false);
    }
  }, [statusFilter, employeeFilter]);

  useEffect(() => { void load(); }, [load]);

  const handleFile = useCallback(async (file: File) => {
    if (!pickedEmployee) {
      setUploadMsg("Set the employee email first.");
      return;
    }
    setUploading(true);
    setUploadMsg(null);
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      form.append("employee_email", pickedEmployee);
      if (pickedName) form.append("employee_name", pickedName);
      form.append("doc_type", pickedDocType);
      const res = await fetchWithRefresh("/api/hr/scanned-documents", { method: "POST", body: form });
      const body = (await res.json().catch(() => ({}))) as { ok?: boolean; cached?: boolean; document_id?: string; error?: string; blocked_by?: string[] };
      if (!res.ok || !body.ok) {
        const blockedDetail = body.blocked_by?.length ? ` (${body.blocked_by.join(", ")})` : "";
        setUploadMsg(`Upload failed: ${body.error ?? `HTTP ${res.status}`}${blockedDetail}`);
        return;
      }
      setUploadMsg(body.cached ? "Already in queue — opened existing entry" : "Saved — review below");
      await load();
      if (body.document_id) setExpandedId(body.document_id);
    } finally {
      setUploading(false);
    }
  }, [pickedEmployee, pickedName, pickedDocType, load]);

  const filtered = useMemo(() => docs, [docs]);

  return (
    <div className="space-y-3" data-testid="hr-docs-panel">
      {canUpload && (
        <div
          className="rounded p-3 space-y-2"
          style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)" }}
        >
          <div className="text-xs font-semibold" style={{ color: "var(--wp-text-dim, #aaa)" }}>Upload a document</div>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2 text-xs">
            <input
              type="email"
              value={pickedEmployee}
              onChange={(e) => setPickedEmployee(e.target.value)}
              placeholder="Employee email (required)"
              data-testid="hr-upload-email"
              className="px-2 py-1.5 rounded"
              style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)", fontSize: "16px" }}
            />
            <input
              type="text"
              value={pickedName}
              onChange={(e) => setPickedName(e.target.value)}
              placeholder="Employee name (optional)"
              data-testid="hr-upload-name"
              className="px-2 py-1.5 rounded"
              style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)", fontSize: "16px" }}
            />
            <select
              value={pickedDocType}
              onChange={(e) => setPickedDocType(e.target.value as HrDocType)}
              data-testid="hr-upload-type"
              className="px-2 py-1.5 rounded"
              style={{ background: "var(--wp-dark, #111)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)", fontSize: "16px" }}
            >
              {Object.entries(DOC_TYPE_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
            </select>
          </div>
          <button
            type="button"
            data-testid="hr-upload-trigger"
            onClick={() => inputRef.current?.click()}
            disabled={uploading || !pickedEmployee}
            className="px-3 py-1.5 text-xs font-medium rounded"
            style={{
              background: uploading || !pickedEmployee ? "var(--wp-dark, #111)" : "var(--wp-gold, #eab308)",
              color: uploading || !pickedEmployee ? "var(--wp-text-muted, #6b7280)" : "var(--wp-dark, #111)",
              border: "none",
              cursor: uploading || !pickedEmployee ? "not-allowed" : "pointer",
            }}
          >
            {uploading ? "Reading document…" : "Pick file (image or PDF)"}
          </button>
          <input
            ref={inputRef}
            type="file"
            accept="image/jpeg,image/png,image/tiff,application/pdf,.pdf,.jpg,.jpeg,.png,.tif,.tiff"
            data-testid="hr-upload-input"
            style={{ display: "none" }}
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void handleFile(f);
              e.target.value = "";
            }}
          />
          {uploadMsg && (
            <div data-testid="hr-upload-message" className="text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>{uploadMsg}</div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2">
        <input
          type="search"
          value={employeeFilter}
          onChange={(e) => setEmployeeFilter(e.target.value)}
          placeholder="Filter by employee email…"
          data-testid="hr-employee-filter"
          className="flex-1 min-w-[200px] px-3 py-2 text-sm rounded"
          style={{ background: "var(--wp-dark-surface2, #1a1a1a)", border: "1px solid var(--wp-dark-border, #333)", color: "var(--wp-text, #eee)", fontSize: "16px" }}
        />
        <div className="flex gap-1" data-testid="hr-status-chips">
          {(["all", "pending", "verified", "rejected", "expired"] as const).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => setStatusFilter(s)}
              data-testid={`hr-status-chip-${s}`}
              className="px-2 py-1 text-xs rounded"
              style={{
                background: statusFilter === s ? "var(--wp-gold, #eab308)" : "var(--wp-dark-surface2, #1a1a1a)",
                color: statusFilter === s ? "var(--wp-dark, #111)" : "var(--wp-text-dim, #aaa)",
                border: "1px solid var(--wp-dark-border, #333)",
                cursor: "pointer",
              }}
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div data-testid="hr-docs-error" className="text-sm rounded px-3 py-2" style={{ background: "rgba(248,113,113,0.08)", border: "1px solid #f87171", color: "#f87171" }}>{error}</div>
      )}

      {loading && <div className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>Loading…</div>}

      {!loading && filtered.length === 0 && !error && (
        <div data-testid="hr-docs-empty" className="text-sm" style={{ color: "var(--wp-text-dim, #aaa)" }}>
          No documents match. Upload one above to get started.
        </div>
      )}

      {!loading && filtered.length > 0 && (
        <div className="rounded overflow-x-auto" style={{ border: "1px solid var(--wp-dark-border, #333)" }}>
          <table className="w-full text-sm">
            <thead style={{ background: "var(--wp-dark-surface2, #1a1a1a)" }}>
              <tr>
                {["Employee", "Type", "Doc #", "Expires", "Status", "Uploaded"].map((h) => (
                  <th key={h} className="text-left px-3 py-2 whitespace-nowrap" style={{ color: "var(--wp-text-dim, #aaa)" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => {
                const c = STATUS_COLORS[r.status];
                return (
                  <tr key={r.id} data-testid={`hr-doc-row-${r.id}`} onClick={() => setExpandedId(expandedId === r.id ? null : r.id)} style={{ borderTop: "1px solid var(--wp-dark-border, #333)", cursor: "pointer" }}>
                    <td className="px-3 py-2" style={{ color: "var(--wp-text, #eee)" }}>
                      <div>{r.employee_name ?? "—"}</div>
                      <div className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>{r.employee_email}</div>
                    </td>
                    <td className="px-3 py-2 text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>{DOC_TYPE_LABELS[r.doc_type]}</td>
                    <td className="px-3 py-2 font-mono text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>{r.document_number ?? "—"}</td>
                    <td className="px-3 py-2 text-xs" style={{ color: "var(--wp-text-dim, #aaa)" }}>{fmtDate(r.document_expiry)}</td>
                    <td className="px-3 py-2"><span data-testid={`hr-doc-status-${r.id}`} className="rounded px-2 py-0.5 text-xs" style={{ background: c.bg, color: c.fg, border: `1px solid ${c.border}` }}>{r.status}</span></td>
                    <td className="px-3 py-2 text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>{fmtDate(r.uploaded_at)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

"use client";

/**
 * DocumentsTab — system of record for every HR document Alicia uploads.
 *
 * Drop ANY HR document here (W-4, I-9, benefits renewal, offer letter,
 * handbook, anything). The smart router classifies it, files it under
 * the right category, and shows it here. If it was a benefits renewal,
 * the Benefits tab also picks it up via category filter — no
 * duplication, one source of truth.
 */

import { useEffect, useState } from "react";
import { authHeaders } from "./auth";

type HrCategory =
  | "w4"
  | "i9"
  | "benefits_renewal"
  | "benefits_enrollment"
  | "offer_letter"
  | "handbook"
  | "unclassified";

const CATEGORY_LABELS: Record<HrCategory, string> = {
  w4: "W-4",
  i9: "I-9",
  benefits_renewal: "Benefits renewal",
  benefits_enrollment: "Benefits enrollment",
  offer_letter: "Offer letter",
  handbook: "Handbook",
  unclassified: "Unclassified",
};

const CATEGORIES: HrCategory[] = [
  "w4",
  "i9",
  "benefits_renewal",
  "benefits_enrollment",
  "offer_letter",
  "handbook",
  "unclassified",
];

interface HrDocument {
  id: string;
  filename: string;
  category: HrCategory;
  classification_confidence: number | null;
  size_bytes: number;
  page_count: number | null;
  employee_id: string | null;
  metadata?: {
    fields?: Record<string, unknown>;
    field_count?: number;
    total_fields?: number;
    completeness?: number;
    extraction_notes?: string[];
  };
  uploaded_at: string;
}

interface Employee {
  id: string;
  name: string;
}

interface RoutedUploadResult {
  documentId: string;
  filename: string;
  category: HrCategory;
  confidence: number;
  reasons: string[];
  benefitDocumentId?: string;
  benefitPlanCount?: number;
}

export function DocumentsTab() {
  const [docs, setDocs] = useState<HrDocument[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<HrCategory | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RoutedUploadResult | null>(null);
  const [expandedDoc, setExpandedDoc] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    const r = await fetch("/api/people/documents", { headers: authHeaders() });
    if (r.ok) {
      const data = await r.json();
      setDocs(data.documents ?? []);
    }
    setLoading(false);
  }

  async function loadEmployees() {
    const r = await fetch("/api/people/employees", { headers: authHeaders() });
    if (r.ok) {
      const data = await r.json();
      setEmployees(data.employees ?? []);
    }
  }

  useEffect(() => {
    load();
    loadEmployees();
  }, []);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    setLastResult(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      fd.append("source", "documents_tab");
      const r = await fetch("/api/people/documents", {
        method: "POST",
        headers: authHeaders(),
        body: fd,
      });
      const data = await r.json();
      if (r.status === 401) {
        setError("Your session has expired. Please log in again.");
      } else if (!r.ok) {
        setError(`Upload failed (${r.status}): ${data.error ?? "unknown"}`);
      } else {
        setLastResult(data);
        await load();
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
    }
    setUploading(false);
  }

  async function handleRecategorize(id: string, newCategory: HrCategory) {
    const r = await fetch(`/api/people/documents/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ category: newCategory }),
    });
    if (r.ok) await load();
  }

  async function handleLinkEmployee(id: string, employeeId: string | null) {
    const r = await fetch(`/api/people/documents/${id}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ employee_id: employeeId }),
    });
    if (r.ok) await load();
  }

  async function handleDelete(id: string, name: string) {
    if (!confirm(`Delete "${name}"?`)) return;
    const r = await fetch(`/api/people/documents/${id}`, {
      method: "DELETE",
      headers: authHeaders(),
    });
    if (r.ok) setDocs((prev) => prev.filter((d) => d.id !== id));
  }

  const visible = filter === "all" ? docs : docs.filter((d) => d.category === filter);

  return (
    <div data-tab="documents">
      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const f = e.dataTransfer.files[0];
          if (f) handleFile(f);
        }}
        style={{
          padding: "2.5rem 1.5rem",
          border: "3px dashed var(--wp-border)",
          borderRadius: "12px",
          textAlign: "center",
          background: "var(--wp-card)",
          marginBottom: "1.5rem",
        }}
      >
        <div style={{ fontSize: "2rem", marginBottom: "0.5rem", lineHeight: 1 }} aria-hidden>
          📁
        </div>
        <div style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--wp-text)", marginBottom: "0.4rem" }}>
          {uploading ? "Filing document…" : "Drop any HR document here"}
        </div>
        <div style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", marginBottom: "1rem" }}>
          W-4s, I-9s, benefits renewals, offer letters, handbooks — we'll figure out where it goes.
        </div>
        <button
          type="button"
          disabled={uploading}
          onClick={() => {
            const i = document.createElement("input");
            i.type = "file";
            i.accept = "application/pdf,.pdf";
            i.style.display = "none";
            i.addEventListener("change", () => {
              const f = i.files?.[0];
              if (f) handleFile(f);
              i.remove();
            });
            document.body.appendChild(i);
            i.click();
          }}
          style={{
            padding: "0.6rem 1.4rem",
            background: "var(--wp-gold)",
            color: "var(--wp-dark)",
            border: "none",
            borderRadius: "6px",
            fontWeight: 600,
            fontSize: "0.9rem",
            cursor: uploading ? "wait" : "pointer",
            opacity: uploading ? 0.6 : 1,
          }}
        >
          {uploading ? "Working…" : "Choose a file"}
        </button>
      </div>

      {error && (
        <div style={{ color: "#c44", marginBottom: "1rem", fontSize: "0.85rem", padding: "0.75rem", background: "rgba(204,68,68,0.08)", border: "1px solid #c44", borderRadius: "6px" }}>
          {error}
        </div>
      )}

      {lastResult && (
        <div
          data-routing-toast
          style={{
            padding: "0.75rem 1rem",
            background: "var(--wp-card)",
            borderLeft: `3px solid var(--wp-success)`,
            borderRadius: "4px",
            marginBottom: "1rem",
            fontSize: "0.85rem",
          }}
        >
          <strong>Filed as {CATEGORY_LABELS[lastResult.category]}</strong>{" "}
          <span style={{ color: "var(--wp-text-dim)" }}>
            ({Math.round(lastResult.confidence * 100)}% confidence) — {lastResult.filename}
            {lastResult.benefitPlanCount != null && ` · ${lastResult.benefitPlanCount} plans extracted`}
          </span>
        </div>
      )}

      <div style={{ display: "flex", flexWrap: "wrap", gap: "0.4rem", marginBottom: "1rem" }}>
        <FilterChip label={`All (${docs.length})`} active={filter === "all"} onClick={() => setFilter("all")} />
        {CATEGORIES.map((c) => {
          const count = docs.filter((d) => d.category === c).length;
          if (count === 0 && filter !== c) return null;
          return (
            <FilterChip
              key={c}
              label={`${CATEGORY_LABELS[c]} (${count})`}
              active={filter === c}
              onClick={() => setFilter(c)}
            />
          );
        })}
      </div>

      {loading ? (
        <div style={{ color: "var(--wp-text-dim)" }}>Loading…</div>
      ) : visible.length === 0 ? (
        <div style={{ padding: "2rem", textAlign: "center", border: "1px dashed var(--wp-border)", borderRadius: "8px", color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
          {filter === "all" ? "No documents yet." : `No ${CATEGORY_LABELS[filter as HrCategory].toLowerCase()} documents yet.`}
        </div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, fontSize: "0.85rem" }}>
          {visible.map((d) => {
            const hasExtracted = (d.category === "w4" || d.category === "i9") && d.metadata?.field_count && d.metadata.field_count > 0;
            const isExpanded = expandedDoc === d.id;
            return (
            <li
              key={d.id}
              data-doc-id={d.id}
              style={{
                padding: "0.75rem 0",
                borderBottom: "1px solid var(--wp-border)",
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "1rem" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: "flex", alignItems: "center", gap: "0.4rem" }}>
                  <strong style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.filename}</strong>
                  {hasExtracted && (
                    <span
                      title={`${d.metadata!.field_count}/${d.metadata!.total_fields} fields extracted (${Math.round((d.metadata!.completeness ?? 0) * 100)}%)`}
                      style={{
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                        fontSize: "0.65rem",
                        fontWeight: 700,
                        background: "var(--wp-gold)",
                        color: "var(--wp-dark)",
                        borderRadius: "999px",
                        padding: "0.1rem 0.4rem",
                        lineHeight: 1.2,
                        flexShrink: 0,
                      }}
                    >
                      {d.metadata!.field_count}/{d.metadata!.total_fields}
                    </span>
                  )}
                </div>
                <div style={{ color: "var(--wp-text-dim)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
                  {(d.size_bytes / 1024).toFixed(0)} KB · {d.page_count ?? "?"} pages · uploaded {new Date(d.uploaded_at).toLocaleString()}
                  {d.employee_id && (() => {
                    const emp = employees.find((e) => e.id === d.employee_id);
                    return emp ? ` · ${emp.name}` : null;
                  })()}
                </div>
              </div>
              {hasExtracted && (
                <button
                  onClick={() => setExpandedDoc(isExpanded ? null : d.id)}
                  aria-label={isExpanded ? "Collapse extracted fields" : "Show extracted fields"}
                  style={{
                    padding: "0.3rem 0.6rem",
                    background: isExpanded ? "var(--wp-gold)" : "transparent",
                    color: isExpanded ? "var(--wp-dark)" : "var(--wp-text-dim)",
                    border: `1px solid ${isExpanded ? "var(--wp-gold)" : "var(--wp-border)"}`,
                    borderRadius: "4px",
                    fontSize: "0.7rem",
                    cursor: "pointer",
                    fontWeight: 600,
                    flexShrink: 0,
                  }}
                >
                  {isExpanded ? "Hide fields" : "View fields"}
                </button>
              )}
              <select
                value={d.category}
                onChange={(e) => handleRecategorize(d.id, e.target.value as HrCategory)}
                aria-label={`Category for ${d.filename}`}
                style={{
                  padding: "0.3rem 0.5rem",
                  background: "var(--wp-dark)",
                  color: "var(--wp-text)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "4px",
                  fontSize: "0.8rem",
                }}
              >
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>{CATEGORY_LABELS[c]}</option>
                ))}
              </select>
              <select
                value={d.employee_id ?? ""}
                onChange={(e) => handleLinkEmployee(d.id, e.target.value || null)}
                aria-label={`Employee for ${d.filename}`}
                style={{
                  padding: "0.3rem 0.5rem",
                  background: "var(--wp-dark)",
                  color: "var(--wp-text)",
                  border: "1px solid var(--wp-border)",
                  borderRadius: "4px",
                  fontSize: "0.8rem",
                  maxWidth: "150px",
                }}
              >
                <option value="">No employee</option>
                {employees.map((emp) => (
                  <option key={emp.id} value={emp.id}>{emp.name}</option>
                ))}
              </select>
              <button
                onClick={() => handleDelete(d.id, d.filename)}
                style={{
                  padding: "0.3rem 0.6rem",
                  background: "transparent",
                  color: "#c44",
                  border: "1px solid #c44",
                  borderRadius: "4px",
                  fontSize: "0.7rem",
                  cursor: "pointer",
                }}
              >
                Delete
              </button>
              </div>
              {hasExtracted && isExpanded && d.metadata?.fields && (
                <ExtractedFieldsPanel
                  fields={d.metadata.fields}
                  completeness={d.metadata.completeness ?? 0}
                  notes={d.metadata.extraction_notes ?? []}
                  category={d.category}
                />
              )}
            </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

const FIELD_LABELS: Record<string, string> = {
  employee_name: "Employee name",
  ssn_last_four: "SSN (last 4)",
  address: "Address",
  filing_status: "Filing status",
  multiple_jobs: "Multiple jobs",
  dependents_amount: "Dependents amount",
  extra_withholding: "Extra withholding",
  exempt: "Exempt",
  signed_date: "Signed date",
  employer_ein: "Employer EIN",
  employer_name: "Employer name",
  maiden_name: "Other last names used",
  date_of_birth: "Date of birth",
  email: "Email",
  phone: "Phone",
  citizenship_status: "Citizenship status",
  uscis_number: "USCIS number",
  i94_number: "I-94 number",
  passport_number: "Passport number",
  preparer_used: "Preparer/translator used",
};

function formatFieldValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "--";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (key === "dependents_amount" || key === "extra_withholding") return `$${value.toLocaleString()}`;
    return String(value);
  }
  if (key === "filing_status") {
    const labels: Record<string, string> = {
      single: "Single / Married filing separately",
      married_filing_jointly: "Married filing jointly",
      head_of_household: "Head of household",
    };
    return labels[value as string] ?? String(value);
  }
  if (key === "citizenship_status") {
    const labels: Record<string, string> = {
      citizen: "U.S. Citizen",
      noncitizen_national: "Noncitizen National",
      permanent_resident: "Lawful Permanent Resident",
      alien_authorized: "Alien Authorized to Work",
    };
    return labels[value as string] ?? String(value);
  }
  return String(value);
}

function ExtractedFieldsPanel({
  fields,
  completeness,
  notes,
  category,
}: {
  fields: Record<string, unknown>;
  completeness: number;
  notes: string[];
  category: string;
}) {
  const entries = Object.entries(fields).filter(([k]) => FIELD_LABELS[k]);
  const filled = entries.filter(([, v]) => v !== null && v !== undefined);
  const empty = entries.filter(([, v]) => v === null || v === undefined);

  return (
    <div
      data-extracted-fields
      style={{
        marginTop: "0.5rem",
        padding: "0.75rem",
        background: "rgba(255,255,255,0.03)",
        border: "1px solid var(--wp-border)",
        borderRadius: "6px",
        fontSize: "0.8rem",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "0.5rem" }}>
        <strong style={{ fontSize: "0.8rem" }}>
          Extracted Fields — {CATEGORY_LABELS[category as HrCategory] ?? category}
        </strong>
        <span
          style={{
            fontSize: "0.7rem",
            fontWeight: 600,
            padding: "0.15rem 0.5rem",
            borderRadius: "999px",
            background: completeness >= 0.5 ? "rgba(76,175,80,0.15)" : "rgba(255,193,7,0.15)",
            color: completeness >= 0.5 ? "#4caf50" : "#ffc107",
          }}
        >
          {Math.round(completeness * 100)}% complete
        </span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "0.3rem 1rem" }}>
        {filled.map(([key, val]) => (
          <div key={key} style={{ display: "flex", justifyContent: "space-between", padding: "0.2rem 0", borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
            <span style={{ color: "var(--wp-text-dim)" }}>{FIELD_LABELS[key] ?? key}</span>
            <span style={{ fontWeight: 500, textAlign: "right" }}>{formatFieldValue(key, val)}</span>
          </div>
        ))}
      </div>
      {empty.length > 0 && (
        <div style={{ marginTop: "0.4rem", fontSize: "0.7rem", color: "var(--wp-text-dim)" }}>
          Not found: {empty.map(([k]) => FIELD_LABELS[k] ?? k).join(", ")}
        </div>
      )}
      {notes.length > 0 && (
        <div style={{ marginTop: "0.4rem", fontSize: "0.7rem", color: "var(--wp-text-dim)", fontStyle: "italic" }}>
          {notes.join(" · ")}
        </div>
      )}
    </div>
  );
}

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      style={{
        padding: "0.35rem 0.75rem",
        background: active ? "var(--wp-gold)" : "transparent",
        color: active ? "var(--wp-dark)" : "var(--wp-text-dim)",
        border: `1px solid ${active ? "var(--wp-gold)" : "var(--wp-border)"}`,
        borderRadius: "999px",
        fontSize: "0.75rem",
        fontWeight: 600,
        cursor: "pointer",
      }}
    >
      {label}
    </button>
  );
}

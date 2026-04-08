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
  uploaded_at: string;
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
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);
  const [filter, setFilter] = useState<HrCategory | "all">("all");
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<RoutedUploadResult | null>(null);

  async function load() {
    setLoading(true);
    const r = await fetch("/api/people/documents", { headers: authHeaders() });
    if (r.ok) {
      const data = await r.json();
      setDocs(data.documents ?? []);
    }
    setLoading(false);
  }
  useEffect(() => {
    load();
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
          {visible.map((d) => (
            <li
              key={d.id}
              data-doc-id={d.id}
              style={{
                padding: "0.75rem 0",
                borderBottom: "1px solid var(--wp-border)",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "1rem",
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <strong style={{ display: "block", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{d.filename}</strong>
                <div style={{ color: "var(--wp-text-dim)", fontSize: "0.75rem", marginTop: "0.15rem" }}>
                  {(d.size_bytes / 1024).toFixed(0)} KB · {d.page_count ?? "?"} pages · uploaded {new Date(d.uploaded_at).toLocaleString()}
                </div>
              </div>
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
            </li>
          ))}
        </ul>
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

"use client";

/**
 * BenefitsTab — upload renewal PDF, see parsed plans + AI recommendation.
 *
 * Drag a PDF → server parses, scores, generates a recommendation under
 * the "cheapest practical" rule, generates insights, persists everything,
 * and renders:
 *   - Recommendation card with Accept / Reject buttons (closes the loop
 *     so the brain learns which suggestions are useful)
 *   - Sortable table of all extracted plans
 *   - Inline insights panel
 */

import { useEffect, useState } from "react";
import { authHeaders } from "./auth";

interface RecommendationPayload {
  id: string;
  rule: string;
  plan_id: string;
  plan_name: string | null;
  reasoning: string;
  runners_up: Array<{ plan_id: string; plan_name: string | null; score: number; reasons: string[] }>;
}
interface UploadResult {
  documentId: string;
  planCount: number;
  carrier: string | null;
  effectiveDate: string | null;
  recommendation: RecommendationPayload | null;
  insights: Array<{ title: string; body: string; severity: string; category: string }>;
  textExcerpt?: string;
  pageCount?: number;
}
interface DocSummary {
  id: string;
  filename: string;
  carrier: string | null;
  effective_date: string | null;
  page_count: number;
  uploaded_at: string;
}

export function BenefitsTab() {
  const [docs, setDocs] = useState<DocSummary[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<UploadResult | null>(null);
  const [decided, setDecided] = useState<Set<string>>(new Set());
  const [dragOver, setDragOver] = useState(false);
  const [progressMsg, setProgressMsg] = useState<string | null>(null);

  async function loadDocs() {
    const r = await fetch("/api/people/benefits", { headers: authHeaders() });
    if (!r.ok) return;
    const data = await r.json();
    setDocs(data.documents ?? []);
  }
  useEffect(() => {
    loadDocs();
  }, []);

  async function handleFile(file: File) {
    setUploading(true);
    setError(null);
    setResult(null);
    setProgressMsg(`Uploading ${file.name} (${(file.size / 1024).toFixed(0)} KB)…`);
    try {
      const fd = new FormData();
      fd.append("file", file);
      setProgressMsg(`Parsing ${file.name}…`);
      const r = await fetch("/api/people/benefits", {
        method: "POST",
        headers: authHeaders(),
        body: fd,
      });
      const text = await r.text();
      let data: UploadResult & { error?: string } = {} as UploadResult & { error?: string };
      try { data = JSON.parse(text); } catch { /* keep raw */ }
      if (!r.ok) {
        const excerpt = data.textExcerpt ? `\n\nExtracted text preview:\n${data.textExcerpt.slice(0, 600)}…` : "";
        setError(`Parse failed (${r.status}): ${data.error ?? text.slice(0, 300)}${excerpt}`);
        setProgressMsg(null);
      } else {
        setResult(data);
        setProgressMsg(`Parsed ${data.planCount} plans from ${data.carrier ?? "the document"}.`);
        await loadDocs();
      }
    } catch (e) {
      setError(`Network error: ${(e as Error).message}`);
      setProgressMsg(null);
    }
    setUploading(false);
  }

  async function decide(recId: string, outcome: "accepted" | "rejected") {
    await fetch(`/api/people/recommendations/${recId}`, {
      method: "PATCH",
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ outcome }),
    });
    setDecided((s) => new Set([...s, recId]));
  }

  return (
    <div data-tab="benefits">
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragOver(false);
          const f = e.dataTransfer.files[0];
          if (f) handleFile(f);
        }}
        style={{
          padding: "2.5rem 1.5rem",
          border: `3px dashed ${dragOver ? "var(--wp-gold)" : "var(--wp-border)"}`,
          borderRadius: "12px",
          textAlign: "center",
          background: dragOver ? "rgba(255, 215, 0, 0.08)" : "var(--wp-card)",
          transition: "all 0.15s ease",
          marginBottom: "1.5rem",
        }}
      >
        <div style={{ fontSize: "2rem", marginBottom: "0.5rem", lineHeight: 1 }} aria-hidden>
          📄
        </div>
        <div style={{ fontSize: "1.05rem", fontWeight: 600, color: "var(--wp-text)", marginBottom: "0.4rem" }}>
          {uploading ? "Parsing PDF…" : "Drop a benefits renewal PDF here"}
        </div>
        <div style={{ fontSize: "0.85rem", color: "var(--wp-text-dim)", marginBottom: "1rem" }}>
          We'll extract every plan, score them, and recommend the best one — under 5 seconds.
        </div>
        <button
          type="button"
          disabled={uploading}
          onClick={(e) => {
            e.stopPropagation();
            // Append to DOM before click — some browsers (Safari in
            // particular) drop the change event from a detached input,
            // which is why uploads required two attempts.
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
          {uploading ? "Working…" : "Choose a PDF"}
        </button>
      </div>

      {progressMsg && !error && (
        <div style={{ color: "var(--wp-text-dim)", marginBottom: "1rem", fontSize: "0.85rem" }}>
          {progressMsg}
        </div>
      )}
      {error && (
        <pre
          style={{
            color: "#c44",
            marginBottom: "1rem",
            fontSize: "0.8rem",
            padding: "0.75rem",
            background: "rgba(204, 68, 68, 0.08)",
            borderRadius: "6px",
            border: "1px solid #c44",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
            maxHeight: "300px",
            overflow: "auto",
          }}
        >
          {error}
        </pre>
      )}

      {result?.recommendation && (
        <div
          data-recommendation
          style={{
            padding: "1.25rem",
            background: "var(--wp-card)",
            border: "1px solid var(--wp-gold)",
            borderRadius: "8px",
            marginBottom: "1.5rem",
          }}
        >
          <div style={{ fontSize: "0.7rem", textTransform: "uppercase", letterSpacing: "0.12em", color: "var(--wp-gold)", marginBottom: "0.4rem" }}>
            Recommendation — {result.recommendation.rule.replace(/_/g, " ")}
          </div>
          <h3 style={{ margin: "0 0 0.4rem", fontSize: "1.2rem" }}>
            {result.recommendation.plan_id} {result.recommendation.plan_name && `— ${result.recommendation.plan_name}`}
          </h3>
          <p style={{ color: "var(--wp-text-dim)", fontSize: "0.9rem", margin: "0 0 0.75rem" }}>
            {result.recommendation.reasoning}
          </p>
          {!decided.has(result.recommendation.id) ? (
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <button onClick={() => decide(result.recommendation!.id, "accepted")} style={btn("var(--wp-gold)")}>
                Accept
              </button>
              <button onClick={() => decide(result.recommendation!.id, "rejected")} style={btn()}>
                Reject
              </button>
            </div>
          ) : (
            <div style={{ fontSize: "0.85rem", color: "var(--wp-success)" }}>Decision recorded — the brain is learning.</div>
          )}

          {result.recommendation.runners_up.length > 0 && (
            <details style={{ marginTop: "1rem" }}>
              <summary style={{ cursor: "pointer", fontSize: "0.85rem", color: "var(--wp-text-dim)" }}>
                Runners-up ({result.recommendation.runners_up.length})
              </summary>
              <ul style={{ marginTop: "0.5rem", paddingLeft: "1rem", fontSize: "0.85rem" }}>
                {result.recommendation.runners_up.map((r) => (
                  <li key={r.plan_id}>
                    <strong>{r.plan_id}</strong> — {r.reasons.join(" · ")}
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      )}

      {result?.insights && result.insights.length > 0 && (
        <div data-insights style={{ marginBottom: "1.5rem" }}>
          <h3 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Insights</h3>
          {result.insights.map((ins, i) => (
            <div
              key={i}
              style={{
                padding: "0.8rem 1rem",
                background: "var(--wp-card)",
                borderLeft: `3px solid ${ins.severity === "critical" ? "#c44" : ins.severity === "attention" ? "var(--wp-warning)" : "var(--wp-info)"}`,
                borderRadius: "4px",
                marginBottom: "0.5rem",
                fontSize: "0.85rem",
              }}
            >
              <strong>{ins.title}</strong>
              <p style={{ margin: "0.25rem 0 0", color: "var(--wp-text-dim)" }}>{ins.body}</p>
            </div>
          ))}
        </div>
      )}

      <h3 style={{ fontSize: "1rem", margin: "1rem 0 0.5rem" }}>Uploaded documents ({docs.length})</h3>
      {docs.length === 0 ? (
        <div style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>No documents uploaded yet.</div>
      ) : (
        <ul style={{ listStyle: "none", padding: 0, fontSize: "0.85rem" }}>
          {docs.map((d) => (
            <li key={d.id} style={{ padding: "0.5rem 0", borderBottom: "1px solid var(--wp-border)" }}>
              <strong>{d.filename}</strong>{" "}
              <span style={{ color: "var(--wp-text-dim)" }}>
                — {d.carrier ?? "unknown carrier"}, {d.page_count} pages, uploaded {new Date(d.uploaded_at).toLocaleString()}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function btn(bg = "var(--wp-card)"): React.CSSProperties {
  return {
    padding: "0.5rem 1rem",
    background: bg,
    color: bg === "var(--wp-card)" ? "var(--wp-text)" : "var(--wp-dark)",
    border: "1px solid var(--wp-border)",
    borderRadius: "5px",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.85rem",
  };
}

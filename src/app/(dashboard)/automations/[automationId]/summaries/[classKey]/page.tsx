"use client";

/**
 * Per-class summary page — print-friendly layout that mirrors Alicia's
 * existing Word template. Fetches the assembled summary from
 * `/api/automations/[automationId]/summaries/[classKey]` via
 * `fetchWithRefresh` (CLAUDE.md hard rule: every authenticated client
 * fetch goes through the refresh wrapper).
 *
 * Sections rendered (in the same order Alicia uses today):
 *   1. Class meta (course / date / location / generated_at)
 *   2. Open-exceptions banner — data-quality warnings appear ABOVE the
 *      content so Alicia notices before copying.
 *   3. Attendance — count + the canonical participant list (xlsx).
 *   4. Coordinator notes — one block per coordinator.
 *   5. Instructor notes — one block per instructor.
 *   6. Survey rollup — placeholder until parser-survey ships.
 *
 * Two action buttons at the top:
 *   - "Copy as plain text" — clipboard write (works without DB)
 *   - "Download JSON" — Blob download of the AssembledSummary
 *
 * The DOCX export is Phase 2 — explicitly out of scope per the spec.
 *
 * Auth: unauthenticated visitors are redirected to /login?next=<path>
 * BEFORE any blank content can render (per the dashboard convention).
 */

import { useEffect, useState, use } from "react";
import { fetchWithRefresh, getInstinctToken } from "@/lib/client-auth";
import type {
  AssembledSummary,
  ExceptionRecord,
} from "@/lib/automations/types";

interface PageParams {
  automationId: string;
  classKey: string;
}

interface ApiResponse {
  summary: AssembledSummary;
}

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  const next = encodeURIComponent(window.location.pathname);
  window.location.href = `/login?next=${next}`;
}

/**
 * Render an AssembledSummary as a plain-text block suitable for the
 * clipboard. Mirrors the Word-template layout Alicia delivers today.
 */
function summaryToPlainText(s: AssembledSummary): string {
  const lines: string[] = [];
  lines.push(`PORSCHE ACADEMY — CLASS SUMMARY`);
  lines.push(``);
  lines.push(`Course: ${s.course_type}`);
  lines.push(`Date: ${s.class_date}`);
  lines.push(`Location: ${s.location}`);
  lines.push(``);
  lines.push(`ATTENDANCE`);
  lines.push(`Total: ${s.participants.length}`);
  if (s.participants.length > 0) {
    lines.push(``);
    for (const p of s.participants) lines.push(`  - ${p}`);
  }
  lines.push(``);
  lines.push(`COORDINATOR NOTES`);
  if (s.coordinator_notes.length === 0) lines.push(`  (none received)`);
  for (const note of s.coordinator_notes) {
    lines.push(``);
    lines.push(`From: ${note.author}`);
    if (note.note) lines.push(note.note);
  }
  lines.push(``);
  lines.push(`INSTRUCTOR NOTES`);
  if (s.instructor_notes.length === 0) lines.push(`  (none received)`);
  for (const note of s.instructor_notes) {
    lines.push(``);
    lines.push(`From: ${note.author}`);
    if (note.note) lines.push(note.note);
  }
  lines.push(``);
  lines.push(`SURVEY ROLLUP`);
  if (s.survey) {
    lines.push(`Responses: ${s.survey.response_count}`);
    if (s.survey.average_score !== null)
      lines.push(`Average: ${s.survey.average_score.toFixed(2)} / 5`);
  } else {
    lines.push(`  (survey integration pending)`);
  }
  lines.push(``);
  lines.push(`---`);
  lines.push(`Generated: ${s.generated_at}`);
  return lines.join("\n");
}

function ExceptionBanner({
  exceptions,
}: {
  exceptions: ExceptionRecord[];
}) {
  if (exceptions.length === 0) return null;
  return (
    <div
      role="alert"
      data-testid="open-exceptions-banner"
      style={{
        background: "#fff3cd",
        border: "1px solid #ffeeba",
        borderRadius: 4,
        padding: 12,
        marginBottom: 16,
      }}
    >
      <strong>
        Heads up — {exceptions.length} unresolved data-quality issue
        {exceptions.length === 1 ? "" : "s"} touching this class:
      </strong>
      <ul style={{ marginTop: 8, marginBottom: 0 }}>
        {exceptions.map((exc) => (
          <li key={exc.id}>
            <code>{exc.kind}</code> — {exc.detail}
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function PorscheClassSummaryPage({
  params,
}: {
  params: Promise<PageParams>;
}) {
  const { automationId, classKey: rawClassKey } = use(params);
  // The route segment is URL-encoded (because class_key contains `|`).
  // Decode for display + URL building.
  const classKey = decodeURIComponent(rawClassKey);

  const [summary, setSummary] = useState<AssembledSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    // Auth gate before fetch — blank-dashboard guardrail.
    const token = getInstinctToken();
    if (!token) {
      rerouteToLogin();
      return;
    }

    let cancelled = false;
    (async () => {
      setLoading(true);
      setError(null);
      try {
        const res = await fetchWithRefresh(
          `/api/automations/${encodeURIComponent(
            automationId,
          )}/summaries/${encodeURIComponent(classKey)}`,
        );
        if (cancelled) return;
        if (res.status === 404) {
          setError("No data for this class yet.");
          setSummary(null);
        } else if (!res.ok) {
          setError(`Failed to load summary (HTTP ${res.status}).`);
        } else {
          const json = (await res.json()) as ApiResponse;
          setSummary(json.summary);
        }
      } catch (err) {
        if (!cancelled)
          setError(`Failed to load summary: ${(err as Error).message}`);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [automationId, classKey]);

  async function handleCopyPlainText() {
    if (!summary) return;
    const text = summaryToPlainText(summary);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2_000);
    } catch (err) {
      console.error("[summary] copy failed:", (err as Error).message);
      setError("Could not copy to clipboard.");
    }
  }

  function handleDownloadJson() {
    if (!summary) return;
    const blob = new Blob([JSON.stringify(summary, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `summary-${summary.class_key.replace(/[|/]/g, "_")}.json`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  if (loading) {
    return (
      <main data-testid="summary-loading" style={{ padding: 24 }}>
        Loading summary…
      </main>
    );
  }

  if (error || !summary) {
    return (
      <main data-testid="summary-error" style={{ padding: 24 }}>
        <h1>Class summary</h1>
        <p>{error ?? "No data."}</p>
        <p>
          <small>
            Class key: <code>{classKey}</code>
          </small>
        </p>
      </main>
    );
  }

  return (
    <main
      data-testid="summary-page"
      style={{
        padding: 24,
        maxWidth: 800,
        margin: "0 auto",
        fontFamily: "Helvetica, Arial, sans-serif",
        color: "#222",
      }}
    >
      <ExceptionBanner exceptions={summary.open_exceptions} />

      <header
        data-testid="summary-header"
        style={{ marginBottom: 24, borderBottom: "2px solid #ddd", paddingBottom: 12 }}
      >
        <h1 style={{ margin: 0 }}>Porsche Academy — Class Summary</h1>
        <p style={{ marginTop: 8, marginBottom: 0, color: "#666" }}>
          <strong>{summary.course_type}</strong> · {summary.class_date} ·{" "}
          {summary.location}
        </p>
        <p style={{ marginTop: 4, color: "#999", fontSize: 12 }}>
          Generated: {summary.generated_at}
        </p>
        <div style={{ marginTop: 12 }}>
          <button
            type="button"
            onClick={handleCopyPlainText}
            data-testid="copy-plain-text"
            style={{ marginRight: 8, padding: "8px 12px" }}
          >
            {copied ? "Copied!" : "Copy as plain text"}
          </button>
          <button
            type="button"
            onClick={handleDownloadJson}
            data-testid="download-json"
            style={{ padding: "8px 12px" }}
          >
            Download JSON
          </button>
        </div>
      </header>

      <section data-testid="attendance-section" style={{ marginBottom: 24 }}>
        <h2>Attendance</h2>
        <p>
          <strong>Total:</strong> {summary.participants.length}
        </p>
        {summary.participants.length > 0 ? (
          <ul>
            {summary.participants.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p style={{ color: "#999" }}>
            (No registration roster yet — daily xlsx not yet ingested for this
            class.)
          </p>
        )}
      </section>

      <section data-testid="coordinator-section" style={{ marginBottom: 24 }}>
        <h2>Coordinator notes</h2>
        {summary.coordinator_notes.length === 0 ? (
          <p style={{ color: "#999" }}>(No coordinator report received yet.)</p>
        ) : (
          summary.coordinator_notes.map((note) => (
            <article
              key={note.author}
              style={{
                background: "#f7f7f7",
                padding: 12,
                marginBottom: 8,
                borderRadius: 4,
              }}
            >
              <h3 style={{ marginTop: 0 }}>{note.author}</h3>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  margin: 0,
                }}
              >
                {note.note || "(no free-text answers)"}
              </pre>
            </article>
          ))
        )}
      </section>

      <section data-testid="instructor-section" style={{ marginBottom: 24 }}>
        <h2>Instructor notes</h2>
        {summary.instructor_notes.length === 0 ? (
          <p style={{ color: "#999" }}>(No instructor report received yet.)</p>
        ) : (
          summary.instructor_notes.map((note) => (
            <article
              key={note.author}
              style={{
                background: "#f7f7f7",
                padding: 12,
                marginBottom: 8,
                borderRadius: 4,
              }}
            >
              <h3 style={{ marginTop: 0 }}>{note.author}</h3>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  margin: 0,
                }}
              >
                {note.note || "(no free-text answers)"}
              </pre>
            </article>
          ))
        )}
      </section>

      <section data-testid="survey-section" style={{ marginBottom: 24 }}>
        <h2>Survey rollup</h2>
        {summary.survey ? (
          <>
            <p>
              <strong>Responses:</strong> {summary.survey.response_count}
            </p>
            {summary.survey.average_score !== null && (
              <p>
                <strong>Average:</strong>{" "}
                {summary.survey.average_score.toFixed(2)} / 5
              </p>
            )}
          </>
        ) : (
          <p style={{ color: "#999" }}>
            (Survey integration pending — see open-exceptions banner once
            survey artifacts begin arriving.)
          </p>
        )}
      </section>
    </main>
  );
}

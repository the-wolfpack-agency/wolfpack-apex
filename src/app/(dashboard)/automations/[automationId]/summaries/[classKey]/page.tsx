"use client";

/**
 * Per-class summary page — print-friendly layout that mirrors the program owner's
 * existing Word template. Fetches the assembled summary from
 * `/api/automations/[automationId]/summaries/[classKey]` via
 * `fetchWithRefresh` (CLAUDE.md hard rule: every authenticated client
 * fetch goes through the refresh wrapper).
 *
 * Sections rendered (in the same order the program team uses today):
 *   1. Class meta (course / date / location / generated_at)
 *   2. Open-exceptions banner — data-quality warnings appear ABOVE the
 *      content so the program owner notices before copying.
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
import Link from "next/link";
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
 * clipboard. Mirrors the Word-template layout the program team delivers today.
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
        background: "rgba(229,180,69,0.12)",
        border: "1px solid var(--wp-gold)",
        borderLeftWidth: 4,
        borderRadius: 6,
        padding: "0.7rem 0.9rem",
        marginTop: "1rem",
        marginBottom: "1rem",
        color: "var(--wp-text)",
      }}
    >
      <strong>
        ⚠ Heads up — {exceptions.length} unresolved data-quality issue
        {exceptions.length === 1 ? "" : "s"} touching this class:
      </strong>
      <ul style={{ marginTop: "0.4rem", marginBottom: 0, paddingLeft: "1.2rem" }}>
        {exceptions.map((exc) => (
          <li key={exc.id}>
            <code style={{ color: "var(--wp-gold)" }}>{exc.kind}</code> · {exc.detail}
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
        padding: "2rem",
        maxWidth: 880,
        margin: "0 auto",
        color: "var(--wp-text)",
      }}
    >
      <Link
        href={`/automations/${encodeURIComponent(automationId)}/summaries`}
        data-testid="summary-breadcrumb"
        style={{
          fontSize: "0.8rem",
          color: "var(--wp-text-dim)",
          textDecoration: "none",
        }}
      >
        ← Back to summaries
      </Link>

      <ExceptionBanner exceptions={summary.open_exceptions} />

      <header
        data-testid="summary-header"
        style={{
          marginTop: "0.4rem",
          marginBottom: "1.5rem",
          borderBottom: "1px solid var(--wp-border)",
          paddingBottom: "0.9rem",
        }}
      >
        <h1 style={{ margin: 0, fontSize: "1.8rem" }}>
          Porsche Academy · Class summary
        </h1>
        <p
          style={{
            marginTop: "0.5rem",
            marginBottom: 0,
            color: "var(--wp-text-dim)",
            fontSize: "0.95rem",
          }}
        >
          <strong style={{ color: "var(--wp-text)" }}>
            {summary.course_type}
          </strong>{" "}
          · {summary.class_date} · {summary.location}
        </p>
        <p
          style={{
            marginTop: "0.3rem",
            color: "var(--wp-text-dim)",
            fontSize: "0.75rem",
          }}
        >
          Generated {new Date(summary.generated_at).toLocaleString()}
        </p>
        <div style={{ marginTop: "0.9rem", display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
          <button
            type="button"
            onClick={handleCopyPlainText}
            data-testid="copy-plain-text"
            style={{
              background: copied ? "rgba(80,175,110,0.18)" : "var(--wp-gold)",
              color: copied ? "var(--wp-text)" : "var(--wp-dark)",
              border: "none",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              fontWeight: 600,
              cursor: "pointer",
              transition: "background 120ms",
            }}
          >
            {copied ? "✓ Copied" : "Copy as plain text"}
          </button>
          <button
            type="button"
            onClick={handleDownloadJson}
            data-testid="download-json"
            style={{
              background: "transparent",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border)",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Download JSON
          </button>
        </div>
      </header>

      <section data-testid="attendance-section" style={{ marginBottom: "1.8rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.4rem" }}>Attendance</h2>
        <p style={{ margin: "0 0 0.4rem" }}>
          <strong>Total:</strong> {summary.participants.length}
        </p>
        {summary.participants.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: "1.2rem", lineHeight: 1.6 }}>
            {summary.participants.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : (
          <p style={{ color: "var(--wp-text-dim)", fontStyle: "italic" }}>
            No registration roster yet. The daily Porsche xlsx hasn't been
            ingested for this class — wait for the next poll, or use Run now
            on the automation page.
          </p>
        )}
      </section>

      <section data-testid="coordinator-section" style={{ marginBottom: "1.8rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.4rem" }}>
          Coordinator notes
        </h2>
        {summary.coordinator_notes.length === 0 ? (
          <p style={{ color: "var(--wp-text-dim)", fontStyle: "italic" }}>
            No coordinator report received yet.
          </p>
        ) : (
          summary.coordinator_notes.map((note) => (
            <article
              key={note.author}
              style={{
                background: "var(--wp-card)",
                border: "1px solid var(--wp-border)",
                padding: "0.8rem 1rem",
                marginBottom: "0.6rem",
                borderRadius: 6,
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "0.4rem", fontSize: "0.95rem" }}>
                {note.author}
              </h3>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  margin: 0,
                  color: "var(--wp-text)",
                  fontSize: "0.9rem",
                  lineHeight: 1.55,
                }}
              >
                {note.note || "(no free-text answers)"}
              </pre>
            </article>
          ))
        )}
      </section>

      <section data-testid="instructor-section" style={{ marginBottom: "1.8rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.4rem" }}>
          Instructor notes
        </h2>
        {summary.instructor_notes.length === 0 ? (
          <p style={{ color: "var(--wp-text-dim)", fontStyle: "italic" }}>
            No instructor report received yet.
          </p>
        ) : (
          summary.instructor_notes.map((note) => (
            <article
              key={note.author}
              style={{
                background: "var(--wp-card)",
                border: "1px solid var(--wp-border)",
                padding: "0.8rem 1rem",
                marginBottom: "0.6rem",
                borderRadius: 6,
              }}
            >
              <h3 style={{ marginTop: 0, marginBottom: "0.4rem", fontSize: "0.95rem" }}>
                {note.author}
              </h3>
              <pre
                style={{
                  whiteSpace: "pre-wrap",
                  fontFamily: "inherit",
                  margin: 0,
                  color: "var(--wp-text)",
                  fontSize: "0.9rem",
                  lineHeight: 1.55,
                }}
              >
                {note.note || "(no free-text answers)"}
              </pre>
            </article>
          ))
        )}
      </section>

      <section data-testid="survey-section" style={{ marginBottom: "1.8rem" }}>
        <h2 style={{ fontSize: "1.1rem", marginBottom: "0.4rem" }}>Survey rollup</h2>
        {summary.survey ? (
          <>
            <p style={{ margin: "0 0 0.3rem" }}>
              <strong>Responses:</strong> {summary.survey.response_count}
            </p>
            {summary.survey.average_score !== null && (
              <p style={{ margin: 0 }}>
                <strong>Average:</strong>{" "}
                {summary.survey.average_score.toFixed(2)} / 5
              </p>
            )}
          </>
        ) : (
          <p style={{ color: "var(--wp-text-dim)", fontStyle: "italic" }}>
            Survey integration pending. Once survey artifacts arrive, the
            rollup will appear here and any parse issues will surface in the
            exception banner above.
          </p>
        )}
      </section>
    </main>
  );
}

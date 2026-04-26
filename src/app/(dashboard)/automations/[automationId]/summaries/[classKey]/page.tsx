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
 * Friendly date renderer — strips the time-of-day, millis, and Z that
 * arrive on `class_date` (ISO timestamp from the assembler) so the
 * page header reads "Mon, Apr 20, 2026" instead of
 * "2026-04-20T00:00:00.000Z". Falls through to the raw input if it
 * doesn't parse, so we never silently hide the data.
 */
export function formatClassDate(raw: string): string {
  if (!raw) return "";
  // Pull leading YYYY-MM-DD if present (covers "2026-04-20" and
  // "2026-04-20T00:00:00.000Z"); add midday-UTC so toLocaleDateString
  // doesn't tip back a day on negative-UTC machines.
  const m = raw.match(/^(\d{4}-\d{2}-\d{2})/);
  const iso = m ? `${m[1]}T12:00:00Z` : raw;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return raw;
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
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
  lines.push(`Date: ${formatClassDate(s.class_date)}`);
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
      lines.push(`Overall average: ${s.survey.average_score.toFixed(2)} / 5`);
    for (const q of s.survey.questions) {
      lines.push(``);
      const avg = q.average !== null ? ` — ${q.average.toFixed(2)} / 5` : "";
      lines.push(`${q.question}${avg}`);
      for (const c of q.comments) lines.push(`  - ${c}`);
    }
  } else {
    lines.push(`  (no survey responses ingested yet)`);
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

  function handleDownloadDocx() {
    if (!summary) return;
    /* The export-docx route streams the file. Use a plain link click so
       the browser's auth cookies + Authorization header (via Next.js
       middleware) ride along; reading the bytes via fetch+blob would
       require redoing the JWT bearer dance for nothing. */
    const a = document.createElement("a");
    a.href = `/api/automations/${encodeURIComponent(
      automationId,
    )}/summaries/${encodeURIComponent(rawClassKey)}/export-docx`;
    a.click();
  }

  function handleDownloadPdf() {
    if (!summary) return;
    const a = document.createElement("a");
    a.href = `/api/automations/${encodeURIComponent(
      automationId,
    )}/summaries/${encodeURIComponent(rawClassKey)}/export-pdf`;
    a.click();
  }

  const [uploadState, setUploadState] = useState<
    | { kind: "idle" }
    | { kind: "uploading" }
    | { kind: "ok"; web_url: string }
    | { kind: "skipped"; reason: string }
    | {
        kind: "error";
        message: string;
        diagnostic?: {
          filename?: string;
          course_type?: string;
          class_date?: string;
          location?: string;
          byte_count?: number;
        };
        upstream_status?: number;
      }
  >({ kind: "idle" });

  const [manualIngestState, setManualIngestState] = useState<
    | { kind: "idle" }
    | { kind: "uploading"; sourceType: string }
    | { kind: "ok"; sourceType: string; snapshots: number }
    | {
        kind: "wrong_class";
        sourceType: string;
        snapshots: number;
      }
    | {
        kind: "quarantined";
        sourceType: string;
        exceptionId?: string;
      }
    | { kind: "duplicate"; sourceType: string }
    | { kind: "error"; sourceType: string; message: string }
  >({ kind: "idle" });

  async function refetchSummary(): Promise<AssembledSummary | null> {
    const res = await fetchWithRefresh(
      `/api/automations/${encodeURIComponent(
        automationId,
      )}/summaries/${encodeURIComponent(classKey)}`,
    );
    if (!res.ok) return null;
    const json = (await res.json()) as ApiResponse;
    return json.summary;
  }

  async function handleManualIngest(
    sourceType: "survey" | "cognito_coordinator" | "cognito_instructor" | "porsche_xlsx",
    file: File,
  ) {
    setManualIngestState({ kind: "uploading", sourceType });
    try {
      const form = new FormData();
      form.append("file", file);
      form.append("source_type", sourceType);
      /* Pass the page's class_key so the parser bypasses filename
         regex matching and assigns the snapshot to THIS class — this
         is the deterministic backfill path. */
      form.append("class_key", classKey);
      const res = await fetchWithRefresh(
        `/api/automations/porsche-classes/manual-ingest`,
        { method: "POST", body: form },
      );
      const body = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: {
          snapshots_written?: number;
          parse_status?: string;
          was_duplicate?: boolean;
          exception_id?: string;
        };
        error?: string;
      };
      if (!res.ok || !body.ok) {
        setManualIngestState({
          kind: "error",
          sourceType,
          message: body.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const snapshots = body.result?.snapshots_written ?? 0;
      const parseStatus = body.result?.parse_status;
      const wasDuplicate = body.result?.was_duplicate === true;

      if (snapshots > 0) {
        /* Snapshot landed somewhere — refetch THIS class's summary in
           place. If it now has the matching source_type populated, the
           upload was for this class. Otherwise the parser auto-split
           responses to a different class_key (common for mixed-class
           Cognito exports). */
        const refreshed = await refetchSummary();
        const populated =
          refreshed != null &&
          ((sourceType === "survey" && refreshed.survey != null) ||
            (sourceType === "cognito_coordinator" &&
              refreshed.coordinator_notes.length >
                (summary?.coordinator_notes.length ?? 0)) ||
            (sourceType === "cognito_instructor" &&
              refreshed.instructor_notes.length >
                (summary?.instructor_notes.length ?? 0)) ||
            (sourceType === "porsche_xlsx" &&
              refreshed.participants.length >
                (summary?.participants.length ?? 0)));

        if (refreshed) setSummary(refreshed);

        if (populated) {
          setManualIngestState({ kind: "ok", sourceType, snapshots });
          return;
        }
        setManualIngestState({ kind: "wrong_class", sourceType, snapshots });
        return;
      }
      if (parseStatus === "error_quarantined") {
        setManualIngestState({
          kind: "quarantined",
          sourceType,
          exceptionId: body.result?.exception_id,
        });
        return;
      }
      if (wasDuplicate) {
        setManualIngestState({ kind: "duplicate", sourceType });
        return;
      }
      /* Catch-all: parsed clean but produced no snapshot. */
      setManualIngestState({
        kind: "quarantined",
        sourceType,
        exceptionId: body.result?.exception_id,
      });
    } catch (err) {
      setManualIngestState({
        kind: "error",
        sourceType,
        message: (err as Error).message,
      });
    }
  }

  interface MergeSuggestion {
    class_key: string;
    course_type: string;
    class_date: string;
    location: string;
    source_count: number;
  }
  const [mergeSuggestions, setMergeSuggestions] = useState<MergeSuggestion[]>(
    [],
  );
  const [mergeBusy, setMergeBusy] = useState<string | null>(null);
  const [mergeError, setMergeError] = useState<string | null>(null);

  /* Pull merge suggestions on every successful summary load. Fire-and-
     forget; the banner just doesn't render if the call fails. */
  useEffect(() => {
    if (!summary) return;
    let cancelled = false;
    (async () => {
      try {
        const res = await fetchWithRefresh(
          `/api/automations/${encodeURIComponent(
            automationId,
          )}/summaries/${encodeURIComponent(rawClassKey)}/merge-suggestions`,
        );
        if (cancelled || !res.ok) return;
        const body = (await res.json()) as { suggestions?: MergeSuggestion[] };
        setMergeSuggestions(body.suggestions ?? []);
      } catch {
        /* non-blocking — skip the banner. */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [summary, automationId, rawClassKey]);

  async function handleMergeWith(otherClassKey: string) {
    setMergeBusy(otherClassKey);
    setMergeError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/automations/${encodeURIComponent(automationId)}/override`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: "class_match",
            from: otherClassKey,
            to: classKey,
            reason: `Merged via summary UI by ${
              new Date().toISOString().slice(0, 10)
            }`,
          }),
        },
      );
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setMergeError(body.error ?? `HTTP ${res.status}`);
        return;
      }
      /* Reload the summary so merged snapshots show up. */
      window.location.reload();
    } catch (err) {
      setMergeError((err as Error).message);
    } finally {
      setMergeBusy(null);
    }
  }

  async function handleUploadToSharePoint() {
    if (!summary) return;
    setUploadState({ kind: "uploading" });
    try {
      const res = await fetchWithRefresh(
        `/api/automations/${encodeURIComponent(
          automationId,
        )}/summaries/${encodeURIComponent(rawClassKey)}/upload-sharepoint`,
        { method: "POST" },
      );
      const body = (await res.json()) as {
        ok?: boolean;
        web_url?: string;
        skipped_reason?: string;
        error?: string;
        upstream_status?: number;
        diagnostic?: {
          filename?: string;
          course_type?: string;
          class_date?: string;
          location?: string;
          byte_count?: number;
        };
      };
      if (res.status === 200 && body.ok && body.web_url) {
        setUploadState({ kind: "ok", web_url: body.web_url });
      } else if (res.status === 202 && body.skipped_reason) {
        setUploadState({ kind: "skipped", reason: body.skipped_reason });
      } else {
        setUploadState({
          kind: "error",
          message: body.error ?? `HTTP ${res.status}`,
          diagnostic: body.diagnostic,
          upstream_status: body.upstream_status,
        });
      }
    } catch (err) {
      setUploadState({
        kind: "error",
        message: (err as Error).message,
      });
    }
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
          display: "inline-block",
          padding: "0.6rem 0.5rem",
          margin: "-0.6rem -0.5rem",
          touchAction: "manipulation",
        }}
      >
        ← Back to summaries
      </Link>

      <ExceptionBanner exceptions={summary.open_exceptions} />

      {mergeSuggestions.length > 0 && (
        <div
          data-testid="merge-suggestions-banner"
          role="region"
          aria-label="Possible duplicate classes"
          style={{
            background: "rgba(85,150,255,0.10)",
            border: "1px solid rgba(85,150,255,0.45)",
            borderLeftWidth: 4,
            borderRadius: 6,
            padding: "0.7rem 0.9rem",
            marginTop: "0.6rem",
            marginBottom: "1rem",
            color: "var(--wp-text)",
          }}
        >
          <strong>Possible duplicate {mergeSuggestions.length === 1 ? "class" : "classes"}:</strong>{" "}
          same course + class date but different location.
          <ul style={{ marginTop: "0.4rem", marginBottom: 0, paddingLeft: "1.2rem" }}>
            {mergeSuggestions.map((s) => (
              <li key={s.class_key} style={{ marginBottom: "0.3rem" }}>
                <code style={{ color: "var(--wp-gold)" }}>{s.class_key}</code>{" "}
                <span style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>
                  ({s.source_count} source{s.source_count === 1 ? "" : "s"})
                </span>{" "}
                <button
                  type="button"
                  onClick={() => handleMergeWith(s.class_key)}
                  disabled={mergeBusy === s.class_key}
                  data-testid={`merge-with-${s.class_key}`}
                  style={{
                    background: "transparent",
                    color: "var(--wp-text)",
                    border: "1px solid var(--wp-border)",
                    padding: "0.25rem 0.6rem",
                    borderRadius: 4,
                    fontSize: "0.8rem",
                    cursor: mergeBusy === s.class_key ? "not-allowed" : "pointer",
                    marginLeft: "0.4rem",
                  }}
                >
                  {mergeBusy === s.class_key ? "Merging…" : "Merge with this class"}
                </button>
              </li>
            ))}
          </ul>
          {mergeError && (
            <p
              role="alert"
              data-testid="merge-error"
              style={{ marginTop: "0.4rem", marginBottom: 0, color: "var(--wp-error, #e87b7b)", fontSize: "0.85rem" }}
            >
              Merge failed: {mergeError}
            </p>
          )}
        </div>
      )}

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
          · {formatClassDate(summary.class_date)} · {summary.location}
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
          <button
            type="button"
            onClick={handleDownloadDocx}
            data-testid="download-docx"
            style={{
              background: "transparent",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border)",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Download Word
          </button>
          <button
            type="button"
            onClick={handleDownloadPdf}
            data-testid="download-pdf"
            style={{
              background: "transparent",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border)",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              cursor: "pointer",
            }}
          >
            Download PDF
          </button>
          <button
            type="button"
            onClick={handleUploadToSharePoint}
            data-testid="upload-sharepoint"
            disabled={uploadState.kind === "uploading"}
            style={{
              background:
                uploadState.kind === "ok"
                  ? "rgba(80,175,110,0.18)"
                  : "transparent",
              color: "var(--wp-text)",
              border: "1px solid var(--wp-border)",
              padding: "0.55rem 1rem",
              borderRadius: 6,
              cursor:
                uploadState.kind === "uploading" ? "not-allowed" : "pointer",
            }}
          >
            {uploadState.kind === "uploading"
              ? "Uploading…"
              : uploadState.kind === "ok"
                ? "✓ Uploaded"
                : "Upload to SharePoint"}
          </button>
        </div>
        {uploadState.kind === "ok" && (
          <p
            data-testid="sharepoint-upload-success"
            style={{ marginTop: "0.5rem", fontSize: "0.85rem" }}
          >
            Saved to{" "}
            <a
              href={uploadState.web_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: "var(--wp-gold)" }}
            >
              SharePoint
            </a>
            .
          </p>
        )}
        {uploadState.kind === "skipped" && (
          <p
            data-testid="sharepoint-upload-skipped"
            style={{
              marginTop: "0.5rem",
              fontSize: "0.85rem",
              color: "var(--wp-text-dim)",
            }}
          >
            SharePoint upload skipped — {uploadState.reason.replace(/_/g, " ")}.
            {uploadState.reason === "not_configured" && (
              <>
                {" "}
                Set <code>INSTINCT_SHAREPOINT_SITE_ID</code>,{" "}
                <code>INSTINCT_SHAREPOINT_DRIVE_ID</code>, and{" "}
                <code>INSTINCT_SHAREPOINT_CLASS_SUMMARIES_PATH</code> in Vercel
                env to enable.
              </>
            )}
          </p>
        )}
        {uploadState.kind === "error" && (
          <div
            data-testid="sharepoint-upload-error"
            role="alert"
            style={{
              marginTop: "0.5rem",
              fontSize: "0.85rem",
              color: "var(--wp-error, #e87b7b)",
            }}
          >
            <p style={{ margin: 0 }}>Upload failed: {uploadState.message}</p>
            {uploadState.diagnostic ? (
              <pre
                data-testid="sharepoint-upload-diagnostic"
                style={{
                  marginTop: "0.4rem",
                  fontSize: "0.72rem",
                  color: "var(--wp-text-dim)",
                  background: "var(--wp-dark-surface, #1a1a1a)",
                  border: "1px solid var(--wp-dark-border, #333)",
                  borderRadius: 4,
                  padding: "0.5rem 0.7rem",
                  whiteSpace: "pre-wrap",
                  wordBreak: "break-word",
                  overflowWrap: "anywhere",
                }}
              >
                {[
                  uploadState.upstream_status
                    ? `upstream_status: ${uploadState.upstream_status}`
                    : null,
                  uploadState.diagnostic.filename
                    ? `filename: "${uploadState.diagnostic.filename}"`
                    : null,
                  uploadState.diagnostic.course_type
                    ? `course_type: ${uploadState.diagnostic.course_type}`
                    : null,
                  uploadState.diagnostic.class_date
                    ? `class_date (raw): ${uploadState.diagnostic.class_date}`
                    : null,
                  uploadState.diagnostic.location
                    ? `location: "${uploadState.diagnostic.location}"`
                    : null,
                  uploadState.diagnostic.byte_count
                    ? `byte_count: ${uploadState.diagnostic.byte_count}`
                    : null,
                ]
                  .filter(Boolean)
                  .join("\n")}
              </pre>
            ) : null}
          </div>
        )}
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
        {manualIngestState.kind === "ok" &&
          manualIngestState.sourceType === "survey" && (
            <p
              data-testid="survey-manual-upload-ok"
              role="status"
              style={{
                margin: "0 0 0.6rem",
                color: "rgba(80,175,110,1)",
                fontSize: "0.85rem",
              }}
            >
              ✓ Uploaded — {manualIngestState.snapshots} snapshot
              {manualIngestState.snapshots === 1 ? "" : "s"} landed on
              this class.
            </p>
          )}
        {summary.survey ? (
          <>
            <p style={{ margin: "0 0 0.3rem" }}>
              <strong>Responses:</strong> {summary.survey.response_count}
            </p>
            {summary.survey.average_score !== null && (
              <p style={{ margin: "0 0 0.6rem" }}>
                <strong>Overall average:</strong>{" "}
                {summary.survey.average_score.toFixed(2)} / 5
              </p>
            )}
            {summary.survey.questions.length > 0 && (
              <div data-testid="survey-questions" style={{ marginTop: "0.4rem" }}>
                {summary.survey.questions.map((q) => (
                  <article
                    key={q.question}
                    data-testid="survey-question"
                    style={{
                      background: "var(--wp-card)",
                      border: "1px solid var(--wp-border)",
                      padding: "0.7rem 0.9rem",
                      marginBottom: "0.5rem",
                      borderRadius: 6,
                    }}
                  >
                    <div
                      style={{
                        display: "flex",
                        justifyContent: "space-between",
                        alignItems: "baseline",
                        gap: "0.6rem",
                        flexWrap: "wrap",
                      }}
                    >
                      <h3
                        style={{
                          margin: 0,
                          fontSize: "0.9rem",
                          fontWeight: 600,
                          flex: 1,
                          minWidth: 0,
                        }}
                      >
                        {q.question}
                      </h3>
                      {q.average !== null && (
                        <span
                          data-testid="survey-question-average"
                          style={{
                            color: "var(--wp-gold)",
                            fontSize: "0.85rem",
                            fontWeight: 600,
                            whiteSpace: "nowrap",
                          }}
                        >
                          {q.average.toFixed(2)} / 5
                        </span>
                      )}
                    </div>
                    {q.comments.length > 0 && (
                      <ul
                        style={{
                          marginTop: "0.5rem",
                          marginBottom: 0,
                          paddingLeft: "1.1rem",
                          color: "var(--wp-text-dim)",
                          fontSize: "0.85rem",
                          lineHeight: 1.5,
                        }}
                      >
                        {q.comments.map((c, i) => (
                          <li key={`${q.question}-c-${i}`}>{c}</li>
                        ))}
                      </ul>
                    )}
                  </article>
                ))}
              </div>
            )}
          </>
        ) : (
          <div data-testid="survey-empty">
            <p style={{ color: "var(--wp-text-dim)", fontStyle: "italic", margin: "0 0 0.6rem" }}>
              No survey responses ingested for this class yet. The
              rollup appears here automatically once the Cognito survey
              email arrives — any parse issues will surface in the
              exception banner above.
            </p>
            <label
              data-testid="survey-manual-upload"
              style={{
                display: "inline-flex",
                alignItems: "center",
                gap: "0.5rem",
                padding: "0.5rem 0.9rem",
                background: "transparent",
                color: "var(--wp-text)",
                border: "1px solid var(--wp-border)",
                borderRadius: 6,
                cursor:
                  manualIngestState.kind === "uploading"
                    ? "not-allowed"
                    : "pointer",
                fontSize: "0.85rem",
                touchAction: "manipulation",
              }}
            >
              {manualIngestState.kind === "uploading" &&
              manualIngestState.sourceType === "survey"
                ? "Uploading…"
                : "Upload survey xlsx"}
              <input
                type="file"
                accept=".xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                style={{ display: "none" }}
                disabled={manualIngestState.kind === "uploading"}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) void handleManualIngest("survey", f);
                  /* Allow re-selecting the same file after a failure. */
                  e.target.value = "";
                }}
              />
            </label>
            <p
              style={{
                marginTop: "0.4rem",
                marginBottom: 0,
                color: "var(--wp-text-dim)",
                fontSize: "0.75rem",
              }}
            >
              Backfill path — uploads route through the same parser the
              inbox poller uses, so failures still surface in the
              exception queue. The snapshot is force-assigned to{" "}
              <code>{classKey}</code> regardless of the filename, so you
              can upload the file as Cognito exported it.
            </p>
            {manualIngestState.kind !== "idle" &&
              manualIngestState.sourceType === "survey" && (
              <>
                {manualIngestState.kind === "uploading" && (
                  <p
                    data-testid="survey-manual-upload-progress"
                    role="status"
                    style={{
                      marginTop: "0.4rem",
                      marginBottom: 0,
                      color: "var(--wp-text-dim)",
                      fontSize: "0.85rem",
                    }}
                  >
                    Uploading + parsing…
                  </p>
                )}
                {manualIngestState.kind === "wrong_class" && (
                  <p
                    role="alert"
                    data-testid="survey-manual-upload-wrong-class"
                    style={{
                      marginTop: "0.4rem",
                      marginBottom: 0,
                      color: "var(--wp-gold)",
                      fontSize: "0.85rem",
                    }}
                  >
                    Uploaded — {manualIngestState.snapshots} snapshot
                    {manualIngestState.snapshots === 1 ? "" : "s"} landed,
                    but none for THIS class. The parser routed responses
                    to a different class_key (course / date / location)
                    based on the filename or roster matching. Open{" "}
                    <Link
                      href={`/automations/${encodeURIComponent(automationId)}/summaries`}
                      style={{
                        color: "var(--wp-gold)",
                        textDecoration: "underline",
                      }}
                    >
                      Class summaries
                    </Link>{" "}
                    to find where they landed, or{" "}
                    <Link
                      href={`/automations/${encodeURIComponent(automationId)}/exceptions`}
                      style={{
                        color: "var(--wp-gold)",
                        textDecoration: "underline",
                      }}
                    >
                      check the exception queue
                    </Link>{" "}
                    if the file should have matched here.
                  </p>
                )}
                {manualIngestState.kind === "quarantined" && (
                  <p
                    role="alert"
                    data-testid="survey-manual-upload-quarantined"
                    style={{
                      marginTop: "0.4rem",
                      marginBottom: 0,
                      color: "var(--wp-gold)",
                      fontSize: "0.85rem",
                    }}
                  >
                    Upload landed but the parser couldn&apos;t produce a
                    snapshot for this class.{" "}
                    <Link
                      href={`/automations/${encodeURIComponent(automationId)}/exceptions`}
                      style={{ color: "var(--wp-gold)", textDecoration: "underline" }}
                    >
                      Open the exception queue
                    </Link>{" "}
                    to see the parser&apos;s reason — most often the
                    filename doesn&apos;t encode this class&apos;s
                    course/date/location, or the workbook is missing
                    required columns.
                  </p>
                )}
                {manualIngestState.kind === "duplicate" && (
                  <p
                    role="status"
                    data-testid="survey-manual-upload-duplicate"
                    style={{
                      marginTop: "0.4rem",
                      marginBottom: 0,
                      color: "var(--wp-text-dim)",
                      fontSize: "0.85rem",
                    }}
                  >
                    This file was already ingested before — no new data
                    extracted. Upload a different export or check the
                    summaries page for the class it actually belongs to.
                  </p>
                )}
                {manualIngestState.kind === "error" && (
                  <p
                    role="alert"
                    data-testid="survey-manual-upload-error"
                    style={{
                      marginTop: "0.4rem",
                      marginBottom: 0,
                      color: "var(--wp-error, #e87b7b)",
                      fontSize: "0.85rem",
                    }}
                  >
                    Upload failed: {manualIngestState.message}
                  </p>
                )}
                </>
              )}
          </div>
        )}
      </section>
    </main>
  );
}

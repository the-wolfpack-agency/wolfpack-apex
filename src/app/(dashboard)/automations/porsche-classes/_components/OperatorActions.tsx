"use client";

/**
 * OperatorActions — top-of-page panel for running the porsche-classes
 * automation manually:
 *
 *   1. "Run inbox poll now" — POST /api/automations/porsche-classes/poll
 *      Pulls fresh messages from the logged-in user's mailbox and
 *      surfaces the JSON result inline so the operator can confirm
 *      messages_seen / matched / ingested without leaving the page.
 *
 *   2. "Backfill from file(s)" — multi-file upload to
 *      /api/automations/porsche-classes/manual-ingest. Each file's
 *      source_type is autodetected from the filename:
 *        *.eml + "Coordinator"   → cognito_coordinator
 *        *.eml + "Instructor"    → cognito_instructor
 *        *.xlsx + "Survey Data"  → survey
 *        any other .xlsx         → porsche_xlsx
 *
 * Why this exists: until distribution lists are updated to deliver
 * Cognito + Porsche academy + survey emails directly to the operator,
 * the inbox poll picks up nothing useful. Manual upload is the
 * unblock — drop in the .eml/.xlsx files Alicia shares and the same
 * production pipeline (parser → snapshot → assembler → exception
 * detector → summary) runs end-to-end on real data.
 */

import { useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";

type SourceType =
  | "cognito_coordinator"
  | "cognito_instructor"
  | "survey"
  | "porsche_xlsx";

interface PollResult {
  messages_seen?: number;
  messages_matched?: number;
  artifacts_ingested?: number;
  artifacts_duplicate?: number;
  artifacts_quarantined?: number;
  errors?: number;
  duration_ms?: number;
  skipped?: string;
  fallback_error?: string;
}

interface PollDiag {
  token_email: string | null;
  me_userPrincipalName: string | null;
  inbox_total: number | null;
  inbox_unread: number | null;
  inbox_newest: Array<{ subject: string; from: string; receivedDateTime: string }>;
  fallback_count: number | null;
  error: string | null;
}

interface IngestRow {
  filename: string;
  source_type: SourceType | null;
  status: "pending" | "uploading" | "ok" | "error";
  message?: string;
}

/**
 * Pure helper exported for unit tests — pick the right source_type
 * from a filename so the operator doesn't have to.
 */
export function detectSourceTypeFromFilename(filename: string): SourceType | null {
  const lower = filename.toLowerCase();
  if (lower.endsWith(".eml")) {
    if (/coordinator/i.test(filename)) return "cognito_coordinator";
    if (/instructor|facilitator|onsite/i.test(filename)) return "cognito_instructor";
    return null;
  }
  if (lower.endsWith(".xlsx") || lower.endsWith(".csv")) {
    if (/survey\s*data|survey_data/i.test(filename)) return "survey";
    if (/(101|102)\b.*\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)/i.test(filename)) {
      return "survey";
    }
    return "porsche_xlsx";
  }
  return null;
}

export default function OperatorActions(props: { onChanged?: () => void }) {
  const [pollState, setPollState] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "ok"; result: PollResult; diag?: PollDiag | null }
    | { kind: "error"; message: string }
  >({ kind: "idle" });

  const [files, setFiles] = useState<IngestRow[]>([]);
  const [bulkRunning, setBulkRunning] = useState(false);

  async function runPoll() {
    setPollState({ kind: "running" });
    try {
      const res = await fetchWithRefresh(
        "/api/automations/porsche-classes/poll",
        { method: "POST" },
      );
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPollState({
          kind: "error",
          message: body?.error ?? `HTTP ${res.status}`,
        });
        return;
      }
      const result: PollResult = body?.result ?? {};
      const diag: PollDiag | null = body?.diag ?? null;
      setPollState({ kind: "ok", result, diag });
      props.onChanged?.();
    } catch (err) {
      setPollState({ kind: "error", message: (err as Error).message });
    }
  }

  function onFilesChosen(picked: FileList | null) {
    if (!picked) return;
    const next: IngestRow[] = [];
    for (const f of Array.from(picked)) {
      next.push({
        filename: f.name,
        source_type: detectSourceTypeFromFilename(f.name),
        status: "pending",
      });
    }
    setFiles(next);
  }

  async function uploadAll(picked: File[]) {
    if (picked.length === 0) return;
    setBulkRunning(true);
    const local: IngestRow[] = picked.map((f) => ({
      filename: f.name,
      source_type: detectSourceTypeFromFilename(f.name),
      status: "pending",
    }));
    setFiles(local);
    for (let i = 0; i < picked.length; i++) {
      const f = picked[i];
      if (!f) continue;
      const sourceType = local[i].source_type;
      if (!sourceType) {
        local[i] = {
          ...local[i],
          status: "error",
          message: "could not detect source_type from filename",
        };
        setFiles([...local]);
        continue;
      }
      local[i] = { ...local[i], status: "uploading" };
      setFiles([...local]);
      const form = new FormData();
      form.append("source_type", sourceType);
      form.append("file", f);
      try {
        const res = await fetchWithRefresh(
          "/api/automations/porsche-classes/manual-ingest",
          { method: "POST", body: form },
        );
        const body = await res.json().catch(() => ({}));
        if (!res.ok) {
          local[i] = {
            ...local[i],
            status: "error",
            message: body?.error ?? `HTTP ${res.status}`,
          };
        } else {
          const r = body?.result ?? {};
          local[i] = {
            ...local[i],
            status: "ok",
            message: r.deduplicated
              ? "deduplicated (already ingested)"
              : `snapshot ${r.snapshot_id ?? "ok"}`,
          };
        }
      } catch (err) {
        local[i] = {
          ...local[i],
          status: "error",
          message: (err as Error).message,
        };
      }
      setFiles([...local]);
    }
    setBulkRunning(false);
    props.onChanged?.();
  }

  return (
    <section
      data-testid="operator-actions"
      style={{
        marginTop: "1.2rem",
        marginBottom: "1.2rem",
        border: "1px solid var(--wp-dark-border)",
        borderRadius: 8,
        background: "var(--wp-dark-surface)",
        padding: "1rem 1.1rem",
      }}
    >
      <h3
        style={{
          margin: "0 0 0.6rem",
          color: "var(--wp-text)",
          fontSize: "0.95rem",
          fontWeight: 600,
        }}
      >
        Operator actions
      </h3>
      <p
        style={{
          margin: "0 0 0.9rem",
          color: "var(--wp-text-dim)",
          fontSize: "0.78rem",
          lineHeight: 1.45,
        }}
      >
        Run an inbox poll on demand, or backfill the pipeline by
        uploading .eml / .xlsx files directly.
      </p>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "1rem" }}>
        {/* Poll */}
        <div style={{ flex: "1 1 280px", minWidth: 240 }}>
          <button
            type="button"
            data-testid="operator-actions-poll"
            onClick={() => void runPoll()}
            disabled={pollState.kind === "running"}
            style={{
              padding: "0.55rem 0.95rem",
              borderRadius: 6,
              border: "1px solid var(--wp-gold)",
              background:
                pollState.kind === "running"
                  ? "transparent"
                  : "var(--wp-gold)",
              color:
                pollState.kind === "running"
                  ? "var(--wp-text-dim)"
                  : "var(--wp-dark)",
              fontWeight: 600,
              fontSize: "0.85rem",
              cursor:
                pollState.kind === "running" ? "not-allowed" : "pointer",
            }}
          >
            {pollState.kind === "running"
              ? "Polling…"
              : "Run inbox poll now"}
          </button>
          <div
            data-testid="operator-actions-poll-result"
            style={{
              marginTop: "0.6rem",
              fontSize: "0.78rem",
              color: "var(--wp-text-dim)",
              lineHeight: 1.5,
            }}
          >
            {pollState.kind === "idle" ? (
              <span>Polls your connected mailbox for new artifacts.</span>
            ) : pollState.kind === "running" ? (
              <span>Reading messages from Microsoft Graph…</span>
            ) : pollState.kind === "error" ? (
              <span style={{ color: "var(--wp-error, #c44)" }}>
                Poll failed: {pollState.message}
              </span>
            ) : (
              <>
                <PollSummary result={pollState.result} />
                {pollState.diag ? <PollDiagBlock diag={pollState.diag} /> : null}
              </>
            )}
          </div>
        </div>

        {/* Backfill upload */}
        <div style={{ flex: "1 1 320px", minWidth: 280 }}>
          <label
            htmlFor="operator-actions-file"
            style={{
              display: "inline-block",
              padding: "0.55rem 0.95rem",
              borderRadius: 6,
              border: "1px solid var(--wp-dark-border)",
              background: "var(--wp-dark-surface2)",
              color: "var(--wp-text)",
              fontWeight: 600,
              fontSize: "0.85rem",
              cursor: bulkRunning ? "wait" : "pointer",
              opacity: bulkRunning ? 0.6 : 1,
            }}
          >
            {bulkRunning ? "Uploading…" : "Backfill from file(s)"}
            <input
              id="operator-actions-file"
              data-testid="operator-actions-file-input"
              type="file"
              accept=".eml,.xlsx,.csv"
              multiple
              disabled={bulkRunning}
              style={{ display: "none" }}
              onChange={(e) => {
                // Snapshot the FileList into a plain File[] BEFORE
                // resetting input.value. Setting value="" invalidates
                // the live FileList — without this snapshot the async
                // upload loop reads stale entries and only the first
                // file ingests; the rest sit at "queued" forever.
                const picked = e.target.files
                  ? Array.from(e.target.files)
                  : [];
                e.target.value = "";
                if (picked.length > 0) {
                  void uploadAll(picked);
                } else {
                  onFilesChosen(null);
                }
              }}
            />
          </label>
          <div
            style={{
              marginTop: "0.45rem",
              fontSize: "0.72rem",
              color: "var(--wp-text-muted)",
            }}
          >
            Accepts .eml (Cognito coordinator/instructor reports),
            .xlsx (Porsche roster, survey vendor exports). Source type
            is autodetected from the filename.
          </div>
          {files.length > 0 ? (
            <ul
              data-testid="operator-actions-file-list"
              style={{
                listStyle: "none",
                padding: 0,
                margin: "0.6rem 0 0",
                fontSize: "0.78rem",
                lineHeight: 1.45,
              }}
            >
              {files.map((row, i) => (
                <li
                  key={`${row.filename}:${i}`}
                  data-testid={`operator-actions-file-row-${i}`}
                  data-status={row.status}
                  style={{
                    padding: "0.35rem 0",
                    borderBottom: "1px dashed var(--wp-dark-border)",
                    color:
                      row.status === "error"
                        ? "var(--wp-error, #c44)"
                        : row.status === "ok"
                          ? "var(--wp-success, #22c55e)"
                          : "var(--wp-text-dim)",
                  }}
                >
                  <span style={{ color: "var(--wp-text)" }}>
                    {row.filename}
                  </span>
                  <span
                    style={{
                      color: "var(--wp-text-muted)",
                      marginLeft: 6,
                    }}
                  >
                    [{row.source_type ?? "?"}]
                  </span>
                  <span style={{ marginLeft: 8 }}>
                    {row.status === "pending"
                      ? "queued"
                      : row.status === "uploading"
                        ? "uploading…"
                        : row.status === "ok"
                          ? `✓ ${row.message ?? "ok"}`
                          : `✗ ${row.message ?? "error"}`}
                  </span>
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function PollDiagBlock({ diag }: { diag: PollDiag }) {
  return (
    <div
      data-testid="operator-actions-poll-diag"
      style={{
        marginTop: "0.55rem",
        padding: "0.55rem 0.7rem",
        background: "var(--wp-dark-surface2)",
        border: "1px solid var(--wp-dark-border)",
        borderRadius: 6,
        fontSize: "0.74rem",
        lineHeight: 1.5,
        color: "var(--wp-text-dim)",
      }}
    >
      <div style={{ fontWeight: 600, color: "var(--wp-text)", marginBottom: 4 }}>
        Diagnostic (poll saw 0 messages)
      </div>
      <div>
        Token mailbox: <code>{diag.token_email ?? "(unknown)"}</code>
        {diag.me_userPrincipalName &&
        diag.me_userPrincipalName !== diag.token_email ? (
          <span style={{ color: "var(--wp-warning, #d97706)" }}>
            {" "}
            (Graph /me reports <code>{diag.me_userPrincipalName}</code> — tokens mismatch!)
          </span>
        ) : null}
      </div>
      <div>
        Inbox folder: {diag.inbox_total ?? "?"} total, {diag.inbox_unread ?? "?"} unread ·
        Fallback URL returned {diag.fallback_count ?? "?"} messages
      </div>
      {diag.inbox_newest.length > 0 ? (
        <details style={{ marginTop: 4 }}>
          <summary style={{ cursor: "pointer" }}>
            Newest 5 in inbox (Graph view)
          </summary>
          <ul style={{ margin: "4px 0 0 1rem", padding: 0 }}>
            {diag.inbox_newest.map((m, i) => (
              <li key={i}>
                <code>{m.receivedDateTime}</code> — {m.from} — {m.subject}
              </li>
            ))}
          </ul>
        </details>
      ) : (
        <div style={{ color: "var(--wp-error, #c44)" }}>
          Inbox newest list is empty — token may be bound to wrong mailbox.
        </div>
      )}
      {diag.error ? (
        <div style={{ color: "var(--wp-error, #c44)" }}>
          Probe error: <code>{diag.error}</code>
        </div>
      ) : null}
    </div>
  );
}

function PollSummary({ result }: { result: PollResult }) {
  if (result.skipped) {
    return (
      <span style={{ color: "var(--wp-warning, #d97706)" }}>
        Skipped: <code>{result.skipped}</code>. Connect Microsoft 365 at
        /settings if this says <code>no_user_connected</code>.
      </span>
    );
  }
  return (
    <>
      <span>
        Seen <strong>{result.messages_seen ?? 0}</strong> · Matched{" "}
        <strong>{result.messages_matched ?? 0}</strong> · Ingested{" "}
        <strong style={{ color: "var(--wp-success, #22c55e)" }}>
          {result.artifacts_ingested ?? 0}
        </strong>{" "}
        · Duplicate {result.artifacts_duplicate ?? 0} · Quarantined{" "}
        <strong style={{ color: "var(--wp-error, #c44)" }}>
          {result.artifacts_quarantined ?? 0}
        </strong>{" "}
        · {result.duration_ms ?? 0}ms
      </span>
      {result.fallback_error ? (
        <div
          data-testid="operator-actions-poll-fallback-error"
          style={{ color: "var(--wp-error, #c44)", marginTop: 4 }}
        >
          Fallback failed: <code>{result.fallback_error}</code>
        </div>
      ) : null}
    </>
  );
}

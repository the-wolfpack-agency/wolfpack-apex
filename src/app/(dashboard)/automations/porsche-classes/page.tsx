"use client";

/**
 * /automations/porsche-classes — "This week" dashboard.
 *
 * One row per active class inside the registry's `active_window_days`
 * range. Replaces the generic /automations/[id] summaries-list view
 * for porsche-classes specifically — Next.js routes static segments
 * before dynamic ones, so this page wins at the URL level. The
 * generic [automationId] page still serves any other registered
 * automation (e.g. meeting-insights).
 *
 * Per row:
 *   - Traffic-light status (green/yellow/red) with plain-language label
 *   - Compact source icons (which inputs are in / still missing)
 *   - Last activity timestamp + open-issue count
 *   - "Open" link → existing per-class summary page
 *   - "Send to SharePoint" button (visible only when ready & not yet uploaded)
 *
 * Top-level "Send all ready classes to SharePoint" button loops over
 * ready classes and POSTs the existing upload-sharepoint route, with
 * per-row progress. No bulk-upload route, no new dependency — the
 * existing per-class endpoint is the unit of work.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh } from "@/lib/client-auth";
import AutomationFlowDiagram from "./_components/AutomationFlowDiagram";

const AUTOMATION_ID = "porsche-classes";
const EXPECTED_SOURCE_ORDER = [
  "porsche_xlsx",
  "cognito_coordinator",
  "cognito_instructor",
  "survey",
] as const;

type SourceType = (typeof EXPECTED_SOURCE_ORDER)[number];
type Status = "ready" | "waiting" | "needs_attention";

interface ClassRow {
  class_key: string;
  course_type: string;
  class_date: string;
  location: string;
  sources_present: SourceType[];
  sources_missing: SourceType[];
  status: Status;
  attention_reason?: string;
  sharepoint_uploaded_at: string | null;
  last_activity_at: string;
  open_exception_count: number;
}

interface ApiResponse {
  window: { min: number; max: number };
  classes: ClassRow[];
}

type UploadState =
  | { kind: "idle" }
  | { kind: "uploading" }
  | { kind: "ok"; web_url?: string }
  | { kind: "skipped"; reason: string }
  | { kind: "error"; reason: string };

const SOURCE_LABEL: Record<SourceType, string> = {
  porsche_xlsx: "Roster",
  cognito_coordinator: "Coordinator",
  cognito_instructor: "Instructor",
  survey: "Survey",
};

const SOURCE_ICON: Record<SourceType, string> = {
  porsche_xlsx: "📋",
  cognito_coordinator: "🧑‍💼",
  cognito_instructor: "🎓",
  survey: "📝",
};

const STATUS_LABEL: Record<Status, string> = {
  ready: "Ready to ship",
  waiting: "Still waiting on inputs",
  needs_attention: "Needs your attention",
};

const STATUS_COLOR: Record<Status, string> = {
  ready: "#3aa663",
  waiting: "#e5b445",
  needs_attention: "#c44",
};

export default function PorscheClassesThisWeekPage() {
  const [rows, setRows] = useState<ClassRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [uploads, setUploads] = useState<Record<string, UploadState>>({});
  const [bulkRunning, setBulkRunning] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const r = await fetchWithRefresh(
        `/api/automations/${AUTOMATION_ID}/this-week`,
      );
      if (!r.ok) {
        setError(`Failed to load this week (${r.status})`);
        return;
      }
      const data = (await r.json()) as ApiResponse;
      setRows(data.classes ?? []);
      setError(null);
    } catch (err) {
      setError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  /** Ready classes that haven't been uploaded yet. Bulk-action target. */
  const shippableRows = useMemo(
    () => rows.filter((r) => r.status === "ready" && !r.sharepoint_uploaded_at),
    [rows],
  );

  const uploadOne = useCallback(
    async (classKey: string): Promise<UploadState> => {
      try {
        const r = await fetchWithRefresh(
          `/api/automations/${AUTOMATION_ID}/summaries/${encodeURIComponent(classKey)}/upload-sharepoint`,
          { method: "POST" },
        );
        const body = await r.json().catch(() => ({}));
        if (r.status === 200) {
          return { kind: "ok", web_url: body.web_url };
        }
        if (r.status === 202) {
          return {
            kind: "skipped",
            reason:
              body.skipped_reason === "not_configured"
                ? "SharePoint isn't connected yet"
                : body.skipped_reason === "no_token"
                  ? "Microsoft sign-in expired — reconnect"
                  : (body.skipped_reason ?? "skipped"),
          };
        }
        return {
          kind: "error",
          reason: body.error ?? `Failed (${r.status})`,
        };
      } catch (err) {
        return { kind: "error", reason: (err as Error).message };
      }
    },
    [],
  );

  async function handleUploadOne(classKey: string) {
    setUploads((prev) => ({ ...prev, [classKey]: { kind: "uploading" } }));
    const result = await uploadOne(classKey);
    setUploads((prev) => ({ ...prev, [classKey]: result }));
    /* On success, refresh so the row's sharepoint_uploaded_at flips and
       the "Send to SharePoint" button hides — single source of truth
       is the server. */
    if (result.kind === "ok") {
      await load();
    }
  }

  async function handleUploadAll() {
    if (shippableRows.length === 0) return;
    setBulkRunning(true);
    /* Mark every targeted row as uploading up front so the user sees
       progress immediately, even before any POST returns. */
    setUploads((prev) => {
      const next = { ...prev };
      for (const r of shippableRows) next[r.class_key] = { kind: "uploading" };
      return next;
    });
    /* Sequential, not parallel: SharePoint per-user write throughput is
       low and we want predictable per-row feedback. The bulk button
       remains responsive because each POST is independent. */
    for (const row of shippableRows) {
      const result = await uploadOne(row.class_key);
      setUploads((prev) => ({ ...prev, [row.class_key]: result }));
    }
    setBulkRunning(false);
    await load();
  }

  return (
    <div style={{ padding: "2rem", color: "var(--wp-text)" }}>
      {/*
        This page is the static `/automations/porsche-classes` route,
        which Next.js resolves before `/automations/[automationId]` —
        meaning a link to `/automations/porsche-classes` lands BACK on
        this same page (self-loop, click does nothing). The breadcrumb
        therefore goes to the automations INDEX, not to the (shadowed)
        per-automation overview.
      */}
      <Link
        href="/automations"
        style={{
          fontSize: "0.8rem",
          color: "var(--wp-text-dim)",
          textDecoration: "none",
          /* Inline-block + padding gives a ≥44px touch target so iOS
             reliably picks the link over the surrounding container. The
             negative margin keeps the visual offset unchanged. */
          display: "inline-block",
          padding: "0.6rem 0.5rem",
          margin: "-0.6rem -0.5rem",
          touchAction: "manipulation",
        }}
        data-testid="this-week-back"
      >
        ← Back to automations
      </Link>
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-start",
          gap: "1rem",
          flexWrap: "wrap",
          marginTop: "0.3rem",
        }}
      >
        <div style={{ flex: 1, minWidth: "240px" }}>
          <h1 style={{ fontSize: "1.8rem", margin: "0 0 0.4rem" }}>
            This week — Porsche BA101 / BA102
          </h1>
          <p
            style={{
              color: "var(--wp-text-dim)",
              marginTop: 0,
              marginBottom: 0,
              maxWidth: "60ch",
              lineHeight: 1.4,
            }}
          >
            Every active class shows up here automatically once its first
            email arrives. Green means ready to ship — yellow means
            we&apos;re still waiting on something — red means something
            needs your attention.
          </p>
        </div>
        <button
          type="button"
          onClick={handleUploadAll}
          disabled={shippableRows.length === 0 || bulkRunning}
          data-testid="this-week-bulk-upload"
          style={{
            background:
              shippableRows.length === 0 || bulkRunning
                ? "var(--wp-border)"
                : "var(--wp-gold)",
            color:
              shippableRows.length === 0 || bulkRunning
                ? "var(--wp-text-dim)"
                : "var(--wp-dark)",
            border: "none",
            padding: "0.6rem 1.2rem",
            borderRadius: "6px",
            fontWeight: 600,
            cursor:
              shippableRows.length === 0 || bulkRunning
                ? "not-allowed"
                : "pointer",
          }}
        >
          {bulkRunning
            ? `Sending… (${
                Object.values(uploads).filter((u) => u.kind === "ok").length
              }/${shippableRows.length})`
            : shippableRows.length > 0
              ? `Send all ready classes to SharePoint (${shippableRows.length})`
              : "Send all ready classes to SharePoint"}
        </button>
      </div>

      <AutomationFlowDiagram />

      {loading && (
        <div style={{ color: "var(--wp-text-dim)", marginTop: "1.5rem" }}>
          Loading classes…
        </div>
      )}
      {error && (
        <div
          data-testid="this-week-error"
          style={{
            marginTop: "1.5rem",
            padding: "0.7rem 0.9rem",
            background: "rgba(204,68,68,0.10)",
            border: "1px solid #c44",
            borderLeftWidth: "4px",
            borderRadius: "6px",
            color: "var(--wp-text)",
          }}
        >
          {error}
        </div>
      )}
      {!loading && !error && rows.length === 0 && (
        <div
          data-testid="this-week-empty"
          style={{
            marginTop: "1.5rem",
            padding: "1.2rem",
            background: "var(--wp-card)",
            border: "1px solid var(--wp-border)",
            borderRadius: "8px",
            color: "var(--wp-text-dim)",
            maxWidth: "640px",
          }}
        >
          No active classes this week. New classes show up here
          automatically once their first email arrives.
        </div>
      )}

      {!loading && !error && rows.length > 0 && (
        <div
          data-testid="this-week-list"
          style={{
            marginTop: "1.5rem",
            display: "grid",
            gap: "0.6rem",
          }}
        >
          {rows.map((c) => (
            <ClassRowCard
              key={c.class_key}
              row={c}
              uploadState={uploads[c.class_key] ?? { kind: "idle" }}
              onUpload={() => handleUploadOne(c.class_key)}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ClassRowCard({
  row,
  uploadState,
  onUpload,
}: {
  row: ClassRow;
  uploadState: UploadState;
  onUpload: () => void;
}) {
  const showSendButton =
    row.status === "ready" && !row.sharepoint_uploaded_at;

  return (
    <div
      data-testid={`this-week-row-${row.class_key}`}
      data-status={row.status}
      className="this-week-row"
      style={{
        background: "var(--wp-card)",
        border: "1px solid var(--wp-border)",
        borderLeft: `4px solid ${STATUS_COLOR[row.status]}`,
        borderRadius: "6px",
      }}
    >
      <style jsx>{`
        /* Default: vertical stack on narrow screens — date and source
           emojis were colliding because the 5-column grid was forcing
           every cell into a too-narrow track on phones. */
        .this-week-row {
          display: flex;
          flex-direction: column;
          align-items: stretch;
          gap: 0.6rem;
          padding: 0.9rem 1rem;
        }
        .this-week-row :global([data-row-cell="activity"]) {
          text-align: left;
        }
        .this-week-row :global([data-row-cell="actions"]) {
          justify-content: flex-start;
        }
        @media (min-width: 720px) {
          .this-week-row {
            display: grid;
            grid-template-columns: auto minmax(0, 1fr) auto auto auto;
            gap: 1rem;
            align-items: center;
          }
          .this-week-row :global([data-row-cell="activity"]) {
            text-align: right;
          }
          .this-week-row :global([data-row-cell="actions"]) {
            justify-content: flex-end;
          }
        }
      `}</style>
      {/* Status dot + label */}
      <div
        style={{ display: "flex", alignItems: "center", gap: "0.5rem", minWidth: "150px" }}
        data-testid={`this-week-status-${row.class_key}`}
      >
        <span
          aria-hidden="true"
          style={{
            display: "inline-block",
            width: "10px",
            height: "10px",
            borderRadius: "50%",
            background: STATUS_COLOR[row.status],
          }}
        />
        <span style={{ fontSize: "0.85rem" }}>{STATUS_LABEL[row.status]}</span>
      </div>

      {/* Class name + sub */}
      <div style={{ minWidth: 0 }}>
        <div style={{ fontWeight: 600, fontSize: "0.95rem" }}>
          {row.course_type} · {formatDate(row.class_date)}
        </div>
        <div
          style={{
            color: "var(--wp-text-dim)",
            fontSize: "0.8rem",
            marginTop: "0.15rem",
          }}
        >
          {row.location}
          {row.attention_reason ? ` · ${row.attention_reason}` : ""}
        </div>
      </div>

      {/* Sources */}
      <div
        style={{ display: "flex", gap: "0.35rem" }}
        data-testid={`this-week-sources-${row.class_key}`}
      >
        {EXPECTED_SOURCE_ORDER.map((s) => {
          const present = row.sources_present.includes(s);
          return (
            <span
              key={s}
              title={`${SOURCE_LABEL[s]}: ${present ? "received" : "still waiting"}`}
              data-source={s}
              data-present={present ? "yes" : "no"}
              style={{
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                width: "26px",
                height: "26px",
                borderRadius: "4px",
                fontSize: "0.85rem",
                background: present ? "rgba(58,166,99,0.18)" : "transparent",
                border: `1px solid ${present ? "rgba(58,166,99,0.45)" : "var(--wp-border)"}`,
                color: present ? "var(--wp-text)" : "var(--wp-text-dim)",
                opacity: present ? 1 : 0.6,
              }}
            >
              {SOURCE_ICON[s]}
            </span>
          );
        })}
      </div>

      {/* Last activity + issue count */}
      <div
        data-row-cell="activity"
        style={{
          fontSize: "0.78rem",
          color: "var(--wp-text-dim)",
          minWidth: "120px",
        }}
      >
        <div>Last update {formatTime(row.last_activity_at)}</div>
        {row.open_exception_count > 0 && (
          <div style={{ color: "#c44", marginTop: "0.2rem" }}>
            {row.open_exception_count} open issue
            {row.open_exception_count === 1 ? "" : "s"}
          </div>
        )}
        {row.sharepoint_uploaded_at && (
          <div style={{ color: "#3aa663", marginTop: "0.2rem" }}>
            Uploaded {formatTime(row.sharepoint_uploaded_at)}
          </div>
        )}
      </div>

      {/* Actions */}
      <div
        data-row-cell="actions"
        style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}
      >
        <Link
          href={`/automations/${AUTOMATION_ID}/summaries/${encodeURIComponent(row.class_key)}`}
          data-testid={`this-week-open-${row.class_key}`}
          style={{
            padding: "0.45rem 0.8rem",
            borderRadius: "6px",
            border: "1px solid var(--wp-border)",
            color: "var(--wp-text)",
            background: "transparent",
            textDecoration: "none",
            fontSize: "0.85rem",
          }}
        >
          Open
        </Link>
        {showSendButton && (
          <button
            type="button"
            onClick={onUpload}
            disabled={uploadState.kind === "uploading"}
            data-testid={`this-week-upload-${row.class_key}`}
            style={{
              padding: "0.45rem 0.8rem",
              borderRadius: "6px",
              border: "none",
              background:
                uploadState.kind === "uploading"
                  ? "var(--wp-border)"
                  : "var(--wp-gold)",
              color:
                uploadState.kind === "uploading"
                  ? "var(--wp-text-dim)"
                  : "var(--wp-dark)",
              fontWeight: 600,
              fontSize: "0.85rem",
              cursor: uploadState.kind === "uploading" ? "not-allowed" : "pointer",
            }}
          >
            {uploadState.kind === "uploading"
              ? "Sending…"
              : "Send to SharePoint"}
          </button>
        )}
        {(uploadState.kind === "skipped" || uploadState.kind === "error") && (
          <span
            data-testid={`this-week-upload-feedback-${row.class_key}`}
            data-kind={uploadState.kind}
            style={{
              fontSize: "0.78rem",
              color: uploadState.kind === "error" ? "#c44" : "var(--wp-gold)",
              alignSelf: "center",
            }}
          >
            {uploadState.reason}
          </span>
        )}
      </div>
    </div>
  );
}

function formatDate(iso: string): string {
  if (!iso) return "—";
  const d = new Date(`${iso}T12:00:00Z`);
  return d.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatTime(iso: string): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

"use client";

/**
 * VersionHistoryPanel — unified version timeline for a site's brief.
 *
 * Mounts on the /sites/[id]/edit page as a collapsible `<details>` block.
 * Fetches on expand (lazy — we don't want a page-load GET for a panel
 * the designer might never open). Clicking a row opens a modal with a
 * side-by-side diff against the current brief; the "Restore this
 * version" button inside the modal POSTs the restore and calls the
 * parent's `onRestore` with the new version entry so the edit page can
 * refresh its draft + iframe without a round-trip.
 *
 * Analytics are emitted FROM THE ROUTE for viewed + restored, and from
 * the client (via /api/analytics) for diff-viewed. Keeping the server
 * responsible for the KPI events (viewed + restored) means the learning
 * loop never misses them due to a client-side error or ad-blocker; the
 * diff-viewed event is best-effort because it's a pure UX signal.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type { SiteBrief } from "@/lib/sites-schema";

export interface BriefVersionEntryView {
  id: string;
  kind: "initial" | "ai_extraction" | "prompt_edit" | "manual_save" | "restore";
  siteId: string;
  brief: SiteBrief;
  authorId: string | null;
  authorRole: string | null;
  summary: string;
  createdAt: string;
  parentVersionId: string | null;
}

export interface DiffEntryView {
  path: string;
  op: "add" | "remove" | "replace";
  before?: unknown;
  after?: unknown;
}

export interface VersionHistoryPanelProps {
  siteId: string;
  /** Current saved brief — basis for all diffs shown in the modal. */
  currentBrief: SiteBrief | null;
  /** Called when a restore lands; parent swaps draft + iframe state. */
  onRestore: (entry: BriefVersionEntryView) => void;
}

function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return iso;
  const delta = Math.max(0, Date.now() - then);
  const s = Math.floor(delta / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(then).toLocaleDateString();
}

function kindIcon(kind: BriefVersionEntryView["kind"]): string {
  switch (kind) {
    case "ai_extraction":
      return "AI";
    case "prompt_edit":
      return "P";
    case "manual_save":
      return "S";
    case "restore":
      return "R";
    case "initial":
    default:
      return "·";
  }
}

function kindLabel(kind: BriefVersionEntryView["kind"]): string {
  switch (kind) {
    case "ai_extraction":
      return "AI extraction";
    case "prompt_edit":
      return "Prompt edit";
    case "manual_save":
      return "Manual save";
    case "restore":
      return "Restore";
    case "initial":
    default:
      return "Initial";
  }
}

/* Pure client-side diff — same algorithm as the lib. Duplicated here
 * because this component must NOT import @/lib/brief-versions (which
 * pulls node:crypto + pg via safeQuery). Identical shape guarantees
 * the diff the modal shows matches the one the server computes. */
function diffBriefsClient(a: SiteBrief, b: SiteBrief): DiffEntryView[] {
  const out: DiffEntryView[] = [];
  walk(a as unknown, b as unknown, "", out);
  return out;
}
function walk(
  a: unknown,
  b: unknown,
  path: string,
  out: DiffEntryView[],
): void {
  if (a === b) return;
  if (a === undefined && b !== undefined) {
    out.push({ path, op: "add", after: b });
    return;
  }
  if (a !== undefined && b === undefined) {
    out.push({ path, op: "remove", before: a });
    return;
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    const max = Math.max(a.length, b.length);
    for (let i = 0; i < max; i++) walk(a[i], b[i], `${path}/${i}`, out);
    return;
  }
  if (isPlain(a) && isPlain(b)) {
    const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
    for (const k of keys) walk(a[k], b[k], `${path}/${escapePtr(k)}`, out);
    return;
  }
  if (!equal(a, b)) {
    out.push({ path, op: "replace", before: a, after: b });
  }
}
function isPlain(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equal(a[i], b[i])) return false;
    return true;
  }
  if (isPlain(a) && isPlain(b)) {
    const ak = Object.keys(a);
    const bk = Object.keys(b);
    if (ak.length !== bk.length) return false;
    for (const k of ak) if (!equal(a[k], b[k])) return false;
    return true;
  }
  return false;
}
function escapePtr(s: string): string {
  return s.replace(/~/g, "~0").replace(/\//g, "~1");
}

function formatVal(v: unknown): string {
  if (v === undefined) return "(unset)";
  if (v === null) return "null";
  if (typeof v === "string") return v.length > 80 ? `${v.slice(0, 77)}…` : v;
  try {
    const s = JSON.stringify(v);
    return s.length > 80 ? `${s.slice(0, 77)}…` : s;
  } catch {
    return String(v);
  }
}

export default function VersionHistoryPanel(props: VersionHistoryPanelProps) {
  const { siteId, currentBrief, onRestore } = props;
  const [versions, setVersions] = useState<BriefVersionEntryView[] | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<BriefVersionEntryView | null>(null);
  const [restoring, setRestoring] = useState(false);

  const fetchVersions = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const r = await fetchWithRefresh(`/api/sites/${siteId}/versions`, {
        headers: jsonHeaders(),
      });
      if (!r.ok) {
        setError(`Could not load history (HTTP ${r.status}).`);
        setVersions([]);
        return;
      }
      const data = (await r.json()) as {
        versions?: BriefVersionEntryView[];
      };
      setVersions(data.versions ?? []);
    } catch (err) {
      setError((err as Error).message || "fetch_failed");
      setVersions([]);
    } finally {
      setLoading(false);
    }
  }, [siteId]);

  const onToggle = useCallback(
    (e: React.SyntheticEvent<HTMLDetailsElement>) => {
      const open = e.currentTarget.open;
      if (open && versions === null) {
        void fetchVersions();
      }
    },
    [fetchVersions, versions],
  );

  const openModal = useCallback(
    (v: BriefVersionEntryView) => {
      setSelected(v);
      // Best-effort analytics — never block the modal on the POST.
      if (currentBrief) {
        const fieldChanges = diffBriefsClient(currentBrief, v.brief).length;
        fetchWithRefresh("/api/analytics", {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            event: "site.version_diff_viewed",
            metadata: {
              site_id: siteId,
              version_id: v.id,
              field_changes: fieldChanges,
            },
          }),
        }).catch(() => {});
      }
    },
    [currentBrief, siteId],
  );

  const closeModal = useCallback(() => {
    setSelected(null);
  }, []);

  const restore = useCallback(async () => {
    if (!selected) return;
    setRestoring(true);
    setError(null);
    try {
      const r = await fetchWithRefresh(`/api/sites/${siteId}/versions`, {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({
          action: "restore",
          toVersionId: selected.id,
        }),
      });
      if (!r.ok) {
        const data = (await r.json().catch(() => ({}))) as { error?: string };
        setError(data.error ?? `Restore failed (HTTP ${r.status}).`);
        return;
      }
      const data = (await r.json()) as { version: BriefVersionEntryView };
      onRestore(data.version);
      setSelected(null);
      // Prepend the restore row optimistically so the timeline updates
      // without a second GET.
      setVersions((prev) =>
        prev === null ? [data.version] : [data.version, ...prev],
      );
    } catch (err) {
      setError((err as Error).message || "restore_failed");
    } finally {
      setRestoring(false);
    }
  }, [onRestore, selected, siteId]);

  const diffEntries = useMemo(() => {
    if (!selected || !currentBrief) return [];
    return diffBriefsClient(currentBrief, selected.brief);
  }, [currentBrief, selected]);

  return (
    <>
      <details
        data-testid="version-history-panel"
        style={{
          borderTop: "1px solid rgba(255,255,255,0.08)",
          padding: 16,
        }}
        onToggle={onToggle}
      >
        <summary
          data-testid="version-history-toggle"
          style={{ cursor: "pointer", fontSize: 13, fontWeight: 600 }}
        >
          Version history
          {versions !== null ? ` (${versions.length})` : ""}
        </summary>
        <div style={{ marginTop: 12 }}>
          {loading && (
            <div
              data-testid="version-history-loading"
              style={{ fontSize: 12, opacity: 0.7 }}
            >
              Loading history…
            </div>
          )}
          {error && (
            <div
              data-testid="version-history-error"
              role="alert"
              style={{
                fontSize: 12,
                color: "#ff9292",
                background: "rgba(255,80,80,0.08)",
                padding: "6px 10px",
                borderRadius: 5,
                border: "1px solid rgba(255,80,80,0.2)",
              }}
            >
              {error}
            </div>
          )}
          {versions !== null && !loading && versions.length === 0 && (
            <div
              data-testid="version-history-empty"
              style={{ fontSize: 12, opacity: 0.7 }}
            >
              No previous versions yet. Edits will appear here as you work.
            </div>
          )}
          {versions !== null && versions.length > 0 && (
            <ol
              data-testid="version-history-list"
              style={{
                listStyle: "none",
                margin: 0,
                padding: 0,
                display: "grid",
                gap: 6,
                maxHeight: 360,
                overflowY: "auto",
              }}
            >
              {versions.map((v) => (
                <li
                  key={v.id}
                  data-testid="version-history-entry"
                  data-version-id={v.id}
                  data-kind={v.kind}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "32px 1fr auto",
                    gap: 8,
                    alignItems: "center",
                    padding: "8px 10px",
                    borderRadius: 5,
                    background: "rgba(255,255,255,0.03)",
                    border: "1px solid rgba(255,255,255,0.06)",
                  }}
                >
                  <span
                    data-testid="version-history-icon"
                    aria-label={kindLabel(v.kind)}
                    title={kindLabel(v.kind)}
                    style={{
                      width: 28,
                      height: 28,
                      borderRadius: 14,
                      background: "var(--wp-accent, #f3b841)",
                      color: "#111",
                      fontSize: 11,
                      fontWeight: 700,
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                    }}
                  >
                    {kindIcon(v.kind)}
                  </span>
                  <div style={{ minWidth: 0 }}>
                    <div
                      data-testid="version-history-summary"
                      style={{
                        fontSize: 12,
                        fontWeight: 500,
                        whiteSpace: "nowrap",
                        overflow: "hidden",
                        textOverflow: "ellipsis",
                      }}
                    >
                      {v.summary}
                    </div>
                    <div
                      style={{
                        fontSize: 11,
                        color: "var(--wp-text-dim, #a0a8b4)",
                      }}
                    >
                      <span data-testid="version-history-timestamp">
                        {relativeTime(v.createdAt)}
                      </span>
                      {v.authorId && (
                        <>
                          {" · "}
                          <span data-testid="version-history-author">
                            {v.authorRole ?? "user"}
                          </span>
                        </>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    data-testid="version-history-view-btn"
                    onClick={() => openModal(v)}
                    style={{
                      padding: "4px 10px",
                      fontSize: 12,
                      border: "1px solid rgba(255,255,255,0.12)",
                      borderRadius: 4,
                      background: "transparent",
                      color: "inherit",
                      cursor: "pointer",
                    }}
                  >
                    View
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      </details>

      {selected && (
        <div
          data-testid="version-diff-modal"
          role="dialog"
          aria-modal="true"
          aria-label="Version diff"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
            padding: 16,
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) closeModal();
          }}
        >
          <div
            style={{
              width: "min(960px, 100%)",
              maxHeight: "90vh",
              display: "flex",
              flexDirection: "column",
              background: "var(--wp-card, #141820)",
              border: "1px solid rgba(255,255,255,0.12)",
              borderRadius: 8,
              boxShadow: "0 8px 32px rgba(0,0,0,0.5)",
            }}
          >
            <header
              style={{
                padding: "12px 16px",
                borderBottom: "1px solid rgba(255,255,255,0.08)",
                display: "flex",
                justifyContent: "space-between",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div>
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {selected.summary}
                </div>
                <div
                  style={{
                    fontSize: 11,
                    color: "var(--wp-text-dim, #a0a8b4)",
                  }}
                >
                  {kindLabel(selected.kind)} · {relativeTime(selected.createdAt)}
                </div>
              </div>
              <button
                type="button"
                data-testid="version-diff-close"
                onClick={closeModal}
                aria-label="Close"
                style={{
                  padding: "4px 10px",
                  fontSize: 12,
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 4,
                  color: "inherit",
                  cursor: "pointer",
                }}
              >
                Close
              </button>
            </header>
            <div
              style={{
                flex: 1,
                minHeight: 0,
                overflow: "auto",
                padding: 16,
              }}
            >
              {diffEntries.length === 0 ? (
                <div
                  data-testid="version-diff-empty"
                  style={{ fontSize: 12, opacity: 0.7 }}
                >
                  This version is identical to the current brief.
                </div>
              ) : (
                <ul
                  data-testid="version-diff-list"
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "grid",
                    gap: 8,
                  }}
                >
                  {diffEntries.map((d, idx) => (
                    <li
                      key={`${d.path}-${idx}`}
                      data-testid="version-diff-entry"
                      data-op={d.op}
                      style={{
                        padding: "6px 10px",
                        border: "1px solid rgba(255,255,255,0.08)",
                        borderRadius: 4,
                        background:
                          d.op === "add"
                            ? "rgba(80, 200, 120, 0.08)"
                            : d.op === "remove"
                              ? "rgba(255, 80, 80, 0.08)"
                              : "rgba(255, 200, 80, 0.08)",
                        fontSize: 12,
                      }}
                    >
                      <div
                        style={{
                          fontFamily: "monospace",
                          fontSize: 11,
                          opacity: 0.8,
                        }}
                      >
                        {d.op.toUpperCase()} {d.path || "/"}
                      </div>
                      {d.op !== "add" && (
                        <div
                          data-testid="version-diff-before"
                          style={{ color: "#ff9292" }}
                        >
                          − {formatVal(d.before)}
                        </div>
                      )}
                      {d.op !== "remove" && (
                        <div
                          data-testid="version-diff-after"
                          style={{ color: "#6dcf85" }}
                        >
                          + {formatVal(d.after)}
                        </div>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <footer
              style={{
                padding: 12,
                borderTop: "1px solid rgba(255,255,255,0.08)",
                display: "flex",
                justifyContent: "flex-end",
                gap: 8,
              }}
            >
              <button
                type="button"
                data-testid="version-diff-cancel"
                onClick={closeModal}
                style={{
                  padding: "8px 14px",
                  fontSize: 13,
                  background: "transparent",
                  border: "1px solid rgba(255,255,255,0.12)",
                  borderRadius: 5,
                  color: "inherit",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="version-diff-restore"
                onClick={restore}
                disabled={restoring || diffEntries.length === 0}
                style={{
                  padding: "8px 14px",
                  fontSize: 13,
                  fontWeight: 600,
                  background: restoring
                    ? "rgba(255,255,255,0.1)"
                    : "var(--wp-accent, #f3b841)",
                  color: restoring ? "rgba(255,255,255,0.5)" : "#111",
                  border: "none",
                  borderRadius: 5,
                  cursor:
                    restoring || diffEntries.length === 0
                      ? "default"
                      : "pointer",
                }}
              >
                {restoring ? "Restoring…" : "Restore this version"}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  );
}

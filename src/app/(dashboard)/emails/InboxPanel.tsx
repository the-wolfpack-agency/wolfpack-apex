"use client";

/**
 * /emails — left-rail message list. Replaces Outlook for triage:
 *
 *   - GET /api/emails/inbox?folder=<folder> on mount + on toggle.
 *   - Virtualized scroll (windowed render) once the list exceeds 100 rows.
 *   - Per-thread preview: subject + sender + 1-line snippet + relative
 *     timestamp. Unread = bold + dot indicator (inbox + archived only).
 *   - Click → navigate to /emails?id=<id> (parent picks this up and
 *     opens EmailReader).
 *   - "New email" CTA opens the composer drawer (parent controls).
 *
 * Folder-aware: drives the same panel from any of the four well-known
 * Microsoft Graph folders (inbox, drafts, sent, archived). When the
 * folder changes, the list refetches and the header label / empty
 * state copy / All-vs-Unread toggle adjust accordingly. Drafts + sent
 * have no useful "unread" concept so the toggle is hidden there.
 *
 * All Graph access is server-side via /api/emails/inbox; this component
 * never touches Microsoft Graph directly.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import { emitInsight } from "@/lib/insights/emit";

export type InboxFolder = "inbox" | "drafts" | "sent" | "archived";

export interface InboxRow {
  id: string;
  subject: string;
  from: { name: string; email: string };
  receivedDateTime: string;
  bodyPreview: string;
  isRead: boolean;
  hasAttachments: boolean;
  importance: "low" | "normal" | "high";
  webLink: string;
  /** Present on rows from drafts/sent. Drives draft-click branching. */
  isDraft?: boolean;
}

const FOLDER_LABEL: Record<InboxFolder, string> = {
  inbox: "Inbox",
  drafts: "Drafts",
  sent: "Sent",
  archived: "Archived",
};

const EMPTY_LABEL: Record<InboxFolder, string> = {
  inbox: "Inbox is empty.",
  drafts: "No drafts.",
  sent: "No sent items.",
  archived: "No archived messages.",
};

const FOLDERS_WITH_UNREAD_FILTER: ReadonlySet<InboxFolder> = new Set(["inbox", "archived"]);

interface InboxPanelProps {
  /** Selected message id (highlighted in the list). */
  activeId: string | null;
  onOpen: (row: InboxRow) => void;
  onCompose: () => void;
  /** Reload trigger — bump to force a refresh (after archive/delete). */
  reloadKey?: number;
  userId: string;
  userRole: string;
  /** When true, the panel hides the templates collapse toggle. */
  isMobile?: boolean;
  /**
   * Which folder to list. Defaults to "inbox" for backwards compat with
   * existing call sites.
   */
  folder?: InboxFolder;
}

const PAGE_SIZE = 50;
const ROW_HEIGHT_PX = 72;
const VISIBLE_BUFFER = 8;
const VIRTUALIZE_THRESHOLD = 100;

function formatRelative(iso: string, nowMs = Date.now()): string {
  if (!iso) return "";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "";
  const diff = nowMs - t;
  const m = 60 * 1000;
  const h = 60 * m;
  const d = 24 * h;
  if (diff < m) return "just now";
  if (diff < h) return `${Math.round(diff / m)}m`;
  if (diff < d) return `${Math.round(diff / h)}h`;
  if (diff < 7 * d) return `${Math.round(diff / d)}d`;
  return new Date(iso).toLocaleDateString();
}

function snippet(s: string, max = 80): string {
  const plain = (s || "").replace(/\s+/g, " ").trim();
  return plain.length > max ? `${plain.slice(0, max - 1).trim()}…` : plain;
}

type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; rows: InboxRow[]; nextSkip: number | null; unreadCount?: number }
  | {
      kind: "error";
      code: "unauthorized" | "not_connected" | "scope_missing" | "graph_error" | "rate_limited";
      message?: string;
      retryAfter?: number;
    };

/**
 * Per-row delete state. The inbox-row delete affordance is a 4-state
 * machine — `idle` (the kebab × button), `confirm` (inline two-tap
 * confirm), `deleting` (after the API call fires), `error` (typed
 * scope_missing / graph_error surface). Errors render inline next to
 * the row so the user does not lose context.
 */
type RowDeleteState =
  | { kind: "idle" }
  | { kind: "confirm" }
  | { kind: "deleting" }
  | {
      kind: "error";
      reason: "scope_missing" | "not_connected" | "rate_limited" | "graph_error";
      message: string;
      scope?: string;
    };

/**
 * Surface a structured 4xx/5xx body from /api/emails/messages/[id] as
 * a typed RowDeleteState error. Mirrors the EmailReader buildActionError
 * helper so both surfaces use identical copy on the scope_missing path.
 */
function rowDeleteErrorFromResponse(
  status: number,
  body: { error?: string; code?: string; scope?: string; detail?: string; message?: string; retryAfter?: number } | null,
): Extract<RowDeleteState, { kind: "error" }> {
  if (status === 403 && body?.code === "scope_missing") {
    const scope = body?.scope || "Mail.ReadWrite";
    return {
      kind: "error",
      reason: "scope_missing",
      scope,
      message:
        `Microsoft denied this delete — the ${scope} permission is missing. ` +
        "Reconnect Microsoft 365 in Settings.",
    };
  }
  if (status === 401 || body?.error === "microsoft_not_connected") {
    return {
      kind: "error",
      reason: "not_connected",
      message: "Microsoft 365 isn't connected. Reconnect in Settings.",
    };
  }
  if (status === 429) {
    const ra = typeof body?.retryAfter === "number" ? body.retryAfter : 60;
    return {
      kind: "error",
      reason: "rate_limited",
      message: `Slow down — try again in ${ra}s.`,
    };
  }
  return {
    kind: "error",
    reason: "graph_error",
    message: body?.detail || body?.message || `request_failed_${status}`,
  };
}

export default function InboxPanel({
  activeId,
  onOpen,
  onCompose,
  reloadKey = 0,
  userId,
  userRole,
  isMobile,
  folder = "inbox",
}: InboxPanelProps) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [unreadOnly, setUnreadOnly] = useState<boolean>(false);
  const [scrollTop, setScrollTop] = useState<number>(0);
  const [containerH, setContainerH] = useState<number>(600);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const openedEmittedRef = useRef<boolean>(false);
  /**
   * Row-level delete state, keyed by message id. Only rows in idle,
   * confirm, deleting, or error appear in the map; otherwise the row
   * renders the kebab × button on hover.
   */
  const [rowDelete, setRowDelete] = useState<Record<string, RowDeleteState>>({});
  /** Optimistically-removed row ids — fade-out + drop on success. */
  const [removedIds, setRemovedIds] = useState<Set<string>>(() => new Set());

  function setRowDeleteState(id: string, next: RowDeleteState | null) {
    setRowDelete((prev) => {
      const copy = { ...prev };
      if (next === null) delete copy[id];
      else copy[id] = next;
      return copy;
    });
  }

  const deleteRow = useCallback(
    async (row: InboxRow) => {
      setRowDeleteState(row.id, { kind: "deleting" });
      try {
        const res = await fetchWithRefresh(
          `/api/emails/messages/${encodeURIComponent(row.id)}`,
          { method: "DELETE", headers: jsonHeaders() },
        );
        if (res.status === 200) {
          // Optimistic fade-out: mark id as removed, drop from list
          // after the 200ms transition.
          setRemovedIds((prev) => {
            const next = new Set(prev);
            next.add(row.id);
            return next;
          });
          emitInsight({
            actor: userId,
            role: userRole,
            surface: "email",
            action: "deleted",
            tier: "personal",
            target: row.id,
            payload: {
              thread_id: row.id,
              folder,
              source: "inbox_row",
            },
          });
          setTimeout(() => {
            setState((prev) => {
              if (prev.kind !== "ready") return prev;
              return {
                ...prev,
                rows: prev.rows.filter((r) => r.id !== row.id),
                unreadCount:
                  typeof prev.unreadCount === "number" && !row.isRead
                    ? Math.max(0, prev.unreadCount - 1)
                    : prev.unreadCount,
              };
            });
            setRemovedIds((prev) => {
              const next = new Set(prev);
              next.delete(row.id);
              return next;
            });
            setRowDeleteState(row.id, null);
          }, 200);
          return;
        }
        const body = await res.json().catch(() => null);
        setRowDeleteState(row.id, rowDeleteErrorFromResponse(res.status, body));
        emitInsight({
          actor: userId,
          role: userRole,
          surface: "email",
          action: "delete_failed",
          tier: "personal",
          target: row.id,
          payload: {
            thread_id: row.id,
            folder,
            source: "inbox_row",
            status: res.status,
          },
        });
      } catch (err) {
        setRowDeleteState(row.id, {
          kind: "error",
          reason: "graph_error",
          message: (err as Error).message || "Network error",
        });
      }
    },
    [userId, userRole, folder],
  );

  const showUnreadFilter = FOLDERS_WITH_UNREAD_FILTER.has(folder);

  const load = useCallback(
    async (opts: { unread: boolean; folder: InboxFolder }) => {
      setState({ kind: "loading" });
      const startMs = (typeof performance !== "undefined" && performance.now)
        ? performance.now()
        : Date.now();
      try {
        const params = new URLSearchParams({
          top: String(PAGE_SIZE),
          skip: "0",
          folder: opts.folder,
        });
        // Drafts + sent ignore unreadOnly server-side, but we also avoid
        // sending it so the URL accurately reflects intent.
        if (opts.unread && FOLDERS_WITH_UNREAD_FILTER.has(opts.folder)) {
          params.set("unread", "true");
        }
        const res = await fetchWithRefresh(`/api/emails/inbox?${params.toString()}`, {
          headers: jsonHeaders(),
        });
        const body = await res.json().catch(() => ({}));
        if (res.status === 200 && Array.isArray(body?.messages)) {
          const rows = body.messages as InboxRow[];
          setState({
            kind: "ready",
            rows,
            nextSkip: typeof body.nextSkip === "number" ? body.nextSkip : null,
            unreadCount: typeof body.unreadCount === "number" ? body.unreadCount : undefined,
          });
          const endMs = (typeof performance !== "undefined" && performance.now)
            ? performance.now()
            : Date.now();
          emitInsight({
            actor: userId,
            role: userRole,
            surface: "email",
            action: "folder_loaded",
            tier: "personal",
            payload: {
              folder: opts.folder,
              count: rows.length,
              took_ms: Math.max(0, Math.round(endMs - startMs)),
            },
          });
          if (!openedEmittedRef.current && opts.folder === "inbox") {
            openedEmittedRef.current = true;
            emitInsight({
              actor: userId,
              role: userRole,
              surface: "email",
              action: "inbox_opened",
              tier: "personal",
              payload: {
                unread_count: rows.filter((r) => !r.isRead).length,
                total_count: rows.length,
              },
            });
          }
          return;
        }
        if (res.status === 401) {
          setState({
            kind: "error",
            code: body?.error === "microsoft_not_connected" ? "not_connected" : "unauthorized",
          });
          return;
        }
        if (res.status === 403 && body?.code === "scope_missing") {
          setState({ kind: "error", code: "scope_missing", message: body?.scope ?? "Mail.Read" });
          return;
        }
        if (res.status === 429) {
          setState({ kind: "error", code: "rate_limited", retryAfter: body?.retryAfter ?? 60 });
          return;
        }
        setState({
          kind: "error",
          code: "graph_error",
          message: body?.detail ?? body?.message ?? `request_failed_${res.status}`,
        });
      } catch (err) {
        setState({ kind: "error", code: "graph_error", message: (err as Error).message });
      }
    },
    [userId, userRole],
  );

  useEffect(() => {
    // Initial fetch + refetch on filter / folder / reloadKey change.
    // The setState inside `load` is intentional — same pattern as
    // EmailReader. The alternative (suspending render on a promise)
    // would force the whole /emails page into a Suspense boundary that
    // breaks the existing composer-first tests.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load({ unread: unreadOnly, folder });
  }, [load, unreadOnly, reloadKey, folder]);

  // Virtualization math — windowed slicing only when the list is large.
  const { renderedRows, totalHeight, offsetTop } = useMemo(() => {
    if (state.kind !== "ready") {
      return { renderedRows: [] as { row: InboxRow; index: number }[], totalHeight: 0, offsetTop: 0 };
    }
    const all = state.rows;
    const total = all.length * ROW_HEIGHT_PX;
    if (all.length < VIRTUALIZE_THRESHOLD) {
      return {
        renderedRows: all.map((row, index) => ({ row, index })),
        totalHeight: total,
        offsetTop: 0,
      };
    }
    const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT_PX) - VISIBLE_BUFFER);
    const end = Math.min(
      all.length,
      Math.ceil((scrollTop + containerH) / ROW_HEIGHT_PX) + VISIBLE_BUFFER,
    );
    const window = [];
    for (let i = start; i < end; i++) window.push({ row: all[i], index: i });
    return { renderedRows: window, totalHeight: total, offsetTop: start * ROW_HEIGHT_PX };
  }, [state, scrollTop, containerH]);

  function onClickRow(row: InboxRow) {
    // Drafts: in v1 we surface the row through onOpen exactly like inbox
    // rows. The parent decides whether to open the reader or pivot into
    // the composer. We emit a learning event so we can measure how often
    // drafts get clicked while the composer-pivot is still TODO.
    //
    // TODO(emails-folders-v2): when the parent opts to wire the
    // composer-pivot, replace `draft_clicked_skipped` with
    // `draft_opened_in_composer` and stop firing the skipped event.
    const isDraftRow = folder === "drafts" || Boolean(row.isDraft);
    onOpen(row);
    if (isDraftRow) {
      emitInsight({
        actor: userId,
        role: userRole,
        surface: "email",
        action: "draft_clicked_skipped",
        tier: "personal",
        target: row.id,
        payload: {
          message_id: row.id,
          folder,
        },
      });
      return;
    }
    emitInsight({
      actor: userId,
      role: userRole,
      surface: "email",
      action: "thread_read",
      tier: "personal",
      target: row.id,
      payload: {
        thread_id: row.id,
        message_count: 1,
      },
    });
  }

  function onComposeClick() {
    onCompose();
    emitInsight({
      actor: userId,
      role: userRole,
      surface: "email",
      action: "compose_drawer_opened",
      tier: "personal",
      payload: { source: "inbox_button" },
    });
  }

  return (
    <aside
      style={asideStyle}
      aria-label={FOLDER_LABEL[folder]}
      data-testid="inbox-panel"
      data-folder={folder}
    >
      {/* Hover-reveal for the per-row × delete button. Inline styles
          can't express `:hover`, so we attach a tiny stylesheet scoped
          via the .wp-inbox-row classname. The button is rendered in the
          DOM (so jest can target it) but visually hidden until the row
          (or button) is hovered/focused. The confirm/deleting/error
          slots stay visible because they aren't ".wp-inbox-row-delete". */}
      <style jsx>{`
        :global(.wp-inbox-row .wp-inbox-row-delete) {
          opacity: 0;
          transition: opacity 120ms ease-in;
        }
        :global(.wp-inbox-row:hover .wp-inbox-row-delete),
        :global(.wp-inbox-row:focus-within .wp-inbox-row-delete) {
          opacity: 1;
        }
      `}</style>
      <header style={headerStyle}>
        <span
          style={{ color: "var(--wp-gold)", fontWeight: 600, fontSize: "0.92rem" }}
          data-testid="inbox-header-label"
        >
          {FOLDER_LABEL[folder]}
        </span>
        <button
          type="button"
          onClick={onComposeClick}
          data-testid="inbox-new-email"
          style={newEmailBtn}
          aria-label="New email"
        >
          + New email
        </button>
      </header>

      {showUnreadFilter ? (
        <div
          style={filterRow}
          role="tablist"
          aria-label={`${FOLDER_LABEL[folder]} filter`}
          data-testid="inbox-filter-row"
        >
          <button
            type="button"
            role="tab"
            aria-selected={!unreadOnly}
            onClick={() => setUnreadOnly(false)}
            data-testid="inbox-filter-all"
            style={{ ...filterBtn, ...(unreadOnly ? {} : filterBtnActive) }}
          >
            All
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={unreadOnly}
            onClick={() => setUnreadOnly(true)}
            data-testid="inbox-filter-unread"
            style={{ ...filterBtn, ...(unreadOnly ? filterBtnActive : {}) }}
          >
            Unread{state.kind === "ready" && typeof state.unreadCount === "number" ? ` (${state.unreadCount})` : ""}
          </button>
        </div>
      ) : null}

      <div
        ref={(el) => {
          scrollRef.current = el;
          if (el && el.clientHeight && el.clientHeight !== containerH) {
            setContainerH(el.clientHeight);
          }
        }}
        onScroll={(e) => {
          const t = e.target as HTMLDivElement;
          setScrollTop(t.scrollTop);
          if (t.clientHeight && t.clientHeight !== containerH) setContainerH(t.clientHeight);
        }}
        style={listScroll}
        data-testid="inbox-scroll"
      >
        {state.kind === "loading" ? (
          <p style={emptyStateStyle} data-testid="inbox-loading">
            Loading {FOLDER_LABEL[folder].toLowerCase()}…
          </p>
        ) : state.kind === "error" ? (
          <div style={emptyStateStyle} data-testid="inbox-error" data-code={state.code}>
            {state.code === "not_connected" || state.code === "unauthorized" ? (
              <>
                <p>Connect Microsoft 365 to see your {FOLDER_LABEL[folder].toLowerCase()}.</p>
                <a href="/settings" style={ctaLinkStyle}>Open Settings</a>
              </>
            ) : state.code === "scope_missing" ? (
              <>
                <p>
                  Your Microsoft connection is missing the {state.message ?? "Mail.Read"} permission.
                </p>
                <a href="/settings" style={ctaLinkStyle}>Open Settings</a>
              </>
            ) : state.code === "rate_limited" ? (
              <p>Slow down — try again in {state.retryAfter ?? 60}s.</p>
            ) : (
              <>
                <p>Couldn&apos;t load your {FOLDER_LABEL[folder].toLowerCase()}. {state.message ?? ""}</p>
                <button
                  type="button"
                  onClick={() => void load({ unread: unreadOnly, folder })}
                  style={ctaButtonStyle}
                  data-testid="inbox-retry"
                >
                  Try again
                </button>
              </>
            )}
          </div>
        ) : state.rows.length === 0 ? (
          <p style={emptyStateStyle} data-testid="inbox-empty">
            {unreadOnly && showUnreadFilter ? "No unread messages." : EMPTY_LABEL[folder]}
          </p>
        ) : (
          <div
            style={{ position: "relative", height: totalHeight, minHeight: "100%" }}
            data-testid="inbox-list"
          >
            <div style={{ position: "absolute", top: offsetTop, left: 0, right: 0 }}>
              {renderedRows.map(({ row }) => {
                const active = activeId === row.id;
                const removing = removedIds.has(row.id);
                const delState: RowDeleteState = rowDelete[row.id] ?? { kind: "idle" };
                return (
                  <div
                    key={row.id}
                    data-testid={`inbox-row-wrap-${row.id}`}
                    data-row-delete-state={delState.kind}
                    className="wp-inbox-row"
                    style={{
                      ...rowWrapStyle,
                      ...(active ? rowStyleActive : {}),
                      height: ROW_HEIGHT_PX,
                      opacity: removing ? 0 : 1,
                      transition: "opacity 200ms ease-out",
                      pointerEvents: removing ? "none" : "auto",
                    }}
                  >
                    <button
                      type="button"
                      onClick={() => onClickRow(row)}
                      data-testid={`inbox-row-${row.id}`}
                      data-unread={!row.isRead}
                      style={rowClickAreaStyle}
                      aria-label={`Open email from ${row.from.name || row.from.email || "(unknown sender)"}: ${row.subject || "(no subject)"}`}
                    >
                      <div style={rowTopRow}>
                        <span
                          style={{
                            ...senderStyle,
                            fontWeight: row.isRead ? 500 : 700,
                          }}
                        >
                          {row.from.name || row.from.email || "(unknown sender)"}
                        </span>
                        <span style={timeStyle}>{formatRelative(row.receivedDateTime)}</span>
                      </div>
                      <div style={rowBottomRow}>
                        {!row.isRead ? (
                          <span style={dotStyle} aria-label="Unread" data-testid={`inbox-row-dot-${row.id}`} />
                        ) : null}
                        <span
                          style={{
                            ...subjectStyle,
                            fontWeight: row.isRead ? 400 : 600,
                          }}
                        >
                          {row.subject || "(no subject)"}
                        </span>
                      </div>
                      <span style={previewStyle}>{snippet(row.bodyPreview)}</span>
                    </button>

                    {/* Per-row delete affordance — visible on hover (idle)
                        or always-visible while in confirm/deleting/error.
                        Drafts can be deleted directly; sent items + archived
                        + inbox all use the same DELETE /api/emails/messages/[id]. */}
                    <div style={rowDeleteSlotStyle}>
                      {delState.kind === "idle" ? (
                        <button
                          type="button"
                          aria-label={`Delete email: ${row.subject || "(no subject)"}`}
                          data-testid={`inbox-row-delete-${row.id}`}
                          className="wp-inbox-row-delete"
                          onClick={(e) => {
                            e.stopPropagation();
                            setRowDeleteState(row.id, { kind: "confirm" });
                          }}
                          style={rowDeleteIconBtn}
                          title="Delete email"
                        >
                          ×
                        </button>
                      ) : delState.kind === "confirm" ? (
                        <span
                          data-testid={`inbox-row-confirm-${row.id}`}
                          style={confirmGroupStyle}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <button
                            type="button"
                            data-testid={`inbox-row-confirm-yes-${row.id}`}
                            onClick={(e) => {
                              e.stopPropagation();
                              void deleteRow(row);
                            }}
                            style={confirmYesBtn}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            data-testid={`inbox-row-confirm-no-${row.id}`}
                            aria-label="Cancel delete"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRowDeleteState(row.id, null);
                            }}
                            style={confirmNoBtn}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : delState.kind === "deleting" ? (
                        <span
                          data-testid={`inbox-row-deleting-${row.id}`}
                          style={{ fontSize: "0.7rem", color: "var(--wp-text-dim)" }}
                        >
                          Deleting…
                        </span>
                      ) : (
                        <div
                          role="alert"
                          data-testid={`inbox-row-delete-error-${row.id}`}
                          data-reason={delState.reason}
                          style={rowDeleteErrorStyle}
                          onClick={(e) => e.stopPropagation()}
                        >
                          <span>{delState.message}</span>
                          {delState.reason === "scope_missing" || delState.reason === "not_connected" ? (
                            <>
                              {" "}
                              <Link
                                href="/settings"
                                data-testid={`inbox-row-delete-error-cta-${row.id}`}
                                style={{ color: "var(--wp-gold)" }}
                              >
                                Reconnect
                              </Link>
                            </>
                          ) : null}
                          {" "}
                          <button
                            type="button"
                            aria-label="Dismiss delete error"
                            onClick={(e) => {
                              e.stopPropagation();
                              setRowDeleteState(row.id, null);
                            }}
                            style={dismissErrorBtn}
                          >
                            Dismiss
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>
      {/* On mobile we surface the same New-email control as a fixed-bottom
          chip so the user can compose without scrolling back up. */}
      {isMobile ? (
        <button
          type="button"
          onClick={onComposeClick}
          data-testid="inbox-new-email-mobile"
          style={mobileNewEmailBtn}
          aria-label="New email"
        >
          + New email
        </button>
      ) : null}
    </aside>
  );
}

const asideStyle: React.CSSProperties = {
  width: "100%",
  background: "var(--wp-dark-surface)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 8,
  display: "flex",
  flexDirection: "column",
  overflow: "hidden",
  minHeight: 0,
  flex: 1,
};

const headerStyle: React.CSSProperties = {
  padding: "0.55rem 0.75rem",
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  background: "var(--wp-dark-surface2)",
  borderBottom: "1px solid var(--wp-dark-border)",
  gap: "0.5rem",
};

const newEmailBtn: React.CSSProperties = {
  background: "var(--wp-gold)",
  color: "var(--wp-dark)",
  border: "none",
  borderRadius: 6,
  padding: "0.4rem 0.75rem",
  fontSize: "0.78rem",
  fontWeight: 700,
  cursor: "pointer",
};

const mobileNewEmailBtn: React.CSSProperties = {
  ...newEmailBtn,
  position: "sticky",
  bottom: 12,
  margin: "8px",
  alignSelf: "flex-end",
  boxShadow: "0 6px 16px rgba(0,0,0,0.4)",
};

const filterRow: React.CSSProperties = {
  display: "flex",
  gap: 8,
  padding: "0.5rem 0.75rem",
  borderBottom: "1px solid var(--wp-dark-border)",
};

const filterBtn: React.CSSProperties = {
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text-dim)",
  borderRadius: 999,
  padding: "0.18rem 0.6rem",
  fontSize: "0.74rem",
  cursor: "pointer",
};

const filterBtnActive: React.CSSProperties = {
  background: "var(--wp-gold)",
  color: "var(--wp-dark)",
  borderColor: "var(--wp-gold)",
  fontWeight: 700,
};

const listScroll: React.CSSProperties = {
  flex: 1,
  minHeight: 0,
  overflowY: "auto",
  background: "var(--wp-dark)",
};

const rowStyle: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  width: "100%",
  textAlign: "left",
  padding: "0.55rem 0.75rem",
  background: "transparent",
  border: "none",
  borderBottom: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text)",
  cursor: "pointer",
};

const rowWrapStyle: React.CSSProperties = {
  position: "relative",
  display: "flex",
  width: "100%",
  background: "transparent",
  borderBottom: "1px solid var(--wp-dark-border)",
};

const rowClickAreaStyle: React.CSSProperties = {
  flex: 1,
  display: "flex",
  flexDirection: "column",
  gap: 4,
  textAlign: "left",
  padding: "0.55rem 0.75rem",
  background: "transparent",
  border: "none",
  color: "var(--wp-text)",
  cursor: "pointer",
  minWidth: 0,
};

const rowDeleteSlotStyle: React.CSSProperties = {
  position: "absolute",
  right: 6,
  top: "50%",
  transform: "translateY(-50%)",
  display: "flex",
  alignItems: "center",
  gap: 4,
  zIndex: 1,
  maxWidth: "75%",
};

const rowDeleteIconBtn: React.CSSProperties = {
  background: "var(--wp-dark-surface2)",
  color: "var(--wp-text-dim)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 4,
  width: 22,
  height: 22,
  fontSize: 14,
  lineHeight: 1,
  padding: 0,
  cursor: "pointer",
  display: "flex",
  alignItems: "center",
  justifyContent: "center",
};

const confirmGroupStyle: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 4,
  background: "var(--wp-dark-surface2)",
  borderRadius: 4,
  padding: "2px 4px",
};

const confirmYesBtn: React.CSSProperties = {
  background: "#ff7878",
  color: "var(--wp-dark)",
  border: "none",
  borderRadius: 3,
  padding: "2px 8px",
  fontSize: "0.7rem",
  fontWeight: 700,
  cursor: "pointer",
};

const confirmNoBtn: React.CSSProperties = {
  background: "transparent",
  color: "var(--wp-text)",
  border: "1px solid var(--wp-dark-border)",
  borderRadius: 3,
  padding: "2px 6px",
  fontSize: "0.7rem",
  cursor: "pointer",
};

const rowDeleteErrorStyle: React.CSSProperties = {
  background: "var(--wp-dark-surface2)",
  border: "1px solid #ff7878",
  borderRadius: 4,
  color: "#ff7878",
  fontSize: "0.7rem",
  padding: "2px 6px",
  maxWidth: 320,
  lineHeight: 1.3,
};

const dismissErrorBtn: React.CSSProperties = {
  background: "transparent",
  border: "none",
  color: "var(--wp-text-dim)",
  cursor: "pointer",
  fontSize: "0.7rem",
  textDecoration: "underline",
  padding: 0,
};

const rowStyleActive: React.CSSProperties = {
  background: "var(--wp-dark-surface2)",
};

const rowTopRow: React.CSSProperties = {
  display: "flex",
  justifyContent: "space-between",
  alignItems: "baseline",
  gap: 8,
};

const rowBottomRow: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 6,
  minWidth: 0,
};

const senderStyle: React.CSSProperties = {
  fontSize: "0.82rem",
  color: "var(--wp-text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  maxWidth: "70%",
};

const timeStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--wp-text-dim)",
  flexShrink: 0,
};

const subjectStyle: React.CSSProperties = {
  fontSize: "0.8rem",
  color: "var(--wp-text)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
  flex: 1,
  minWidth: 0,
};

const previewStyle: React.CSSProperties = {
  fontSize: "0.72rem",
  color: "var(--wp-text-dim)",
  overflow: "hidden",
  textOverflow: "ellipsis",
  whiteSpace: "nowrap",
};

const dotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: 999,
  background: "var(--wp-gold)",
  display: "inline-block",
  flexShrink: 0,
};

const emptyStateStyle: React.CSSProperties = {
  padding: "1rem 0.75rem",
  fontSize: "0.82rem",
  color: "var(--wp-text-dim)",
};

const ctaLinkStyle: React.CSSProperties = {
  display: "inline-block",
  marginTop: 8,
  background: "var(--wp-gold)",
  color: "var(--wp-dark)",
  padding: "0.45rem 0.8rem",
  borderRadius: 6,
  fontSize: "0.78rem",
  fontWeight: 700,
  textDecoration: "none",
};

const ctaButtonStyle: React.CSSProperties = {
  ...ctaLinkStyle,
  border: "none",
  cursor: "pointer",
};

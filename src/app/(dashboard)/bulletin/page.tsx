"use client";

/**
 * /bulletin — multi-user bulletin boards.
 *
 * Lists every (non-archived) board the team has spun up, plus a "Create
 * new board" form, plus a collapsible Archived section. Clicking a board
 * navigates to /bulletin/[id] for the interactive sticky-note canvas.
 *
 * Auth: redirects to /login?next=/bulletin BEFORE rendering any content,
 * matching the dashboard convention. We never paint an empty 200 page.
 *
 * Auto-saves and analytics live on the API side; the UI here just talks
 * to the contract documented in /api/bulletin/*.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchWithRefresh,
  jsonHeaders,
  getInstinctToken,
} from "@/lib/client-auth";

interface Board {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /* The list endpoint may return note counts so we can show a chip; if
     missing we just hide the chip. Kept optional so the contract stays
     loose. */
  noteCount?: number;
}

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  window.location.href = "/login?next=/bulletin";
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

const inputStyle: React.CSSProperties = {
  background: "var(--wp-dark)",
  border: "1px solid var(--wp-dark-border)",
  color: "var(--wp-text)",
  borderRadius: 6,
  padding: "0.45rem 0.6rem",
  fontSize: "0.85rem",
};

const btnPrimary: React.CSSProperties = {
  background: "var(--wp-gold)",
  color: "#000",
  border: "none",
  padding: "0.55rem 1rem",
  borderRadius: 6,
  fontWeight: 600,
  fontSize: "0.85rem",
  cursor: "pointer",
};

function SectionCard({
  title,
  children,
  testId,
}: {
  title: string;
  children: React.ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className="rounded-lg border p-5"
      style={{
        background: "var(--wp-dark-surface)",
        borderColor: "var(--wp-dark-border)",
      }}
    >
      <h2
        className="text-sm font-semibold mb-4"
        style={{ color: "var(--wp-gold)" }}
      >
        {title}
      </h2>
      {children}
    </div>
  );
}

function navigateToBoard(id: string) {
  if (typeof window === "undefined") return;
  window.location.href = `/bulletin/${encodeURIComponent(id)}`;
}

export default function BulletinIndexPage() {
  const [authChecked, setAuthChecked] = useState(false);
  const [boards, setBoards] = useState<Board[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const [archivedOpen, setArchivedOpen] = useState(false);

  /* ── auth gate ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!getInstinctToken()) {
      rerouteToLogin();
      return;
    }
    setAuthChecked(true);
  }, []);

  /* ── load list ────────────────────────────────────────────────── */
  const loadList = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchWithRefresh("/api/bulletin/boards");
      if (!res.ok) {
        setLoadError("We couldn't load your boards. Please refresh.");
        return;
      }
      const data = (await res.json()) as { boards: Board[] };
      setBoards(Array.isArray(data.boards) ? data.boards : []);
    } catch (err) {
      setLoadError(`Failed to load boards: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!authChecked) return;
    void loadList();
  }, [authChecked, loadList]);

  /* ── create ───────────────────────────────────────────────────── */
  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!title.trim()) {
      setCreateError("Title is required.");
      return;
    }
    setSubmitting(true);
    setCreateError(null);
    try {
      const body: Record<string, string> = { title: title.trim() };
      if (description.trim()) body.description = description.trim();
      const res = await fetchWithRefresh("/api/bulletin/boards", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setCreateError(errBody.error ?? "Failed to create board.");
        return;
      }
      const data = (await res.json()) as { board: Board };
      /* Optimistically prepend so the user sees the new board even on
         routers that delay the navigation. */
      setBoards((prev) => [data.board, ...prev]);
      setTitle("");
      setDescription("");
      navigateToBoard(data.board.id);
    } catch (err) {
      setCreateError(`Network error: ${(err as Error).message}`);
    } finally {
      setSubmitting(false);
    }
  }

  /* ── partition ────────────────────────────────────────────────── */
  /* Newest first by updatedAt (fall back to createdAt). */
  const sorted = [...boards].sort((a, b) => {
    const av = new Date(a.updatedAt || a.createdAt).getTime();
    const bv = new Date(b.updatedAt || b.createdAt).getTime();
    return bv - av;
  });
  const active = sorted.filter((b) => !b.archivedAt);
  const archived = sorted.filter((b) => Boolean(b.archivedAt));

  /* ── render ───────────────────────────────────────────────────── */
  if (!authChecked) {
    return (
      <div
        data-testid="bulletin-page-loading"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Loading…
      </div>
    );
  }

  return (
    <div
      data-testid="bulletin-page"
      style={{
        display: "grid",
        gap: "1.5rem",
        maxWidth: "100%",
        minWidth: 0,
        overflowX: "hidden",
        padding: "0 1rem",
      }}
    >
      <header>
        <h1
          className="text-2xl font-bold mb-1"
          style={{ color: "var(--wp-gold)" }}
        >
          Bulletin Boards
        </h1>
        <p
          style={{
            color: "var(--wp-text-dim)",
            fontSize: "0.875rem",
            margin: 0,
          }}
        >
          Collaborative notes you can save as meeting artifacts. Spin up
          a board for any topic, drop sticky notes onto the canvas, and
          snapshot the whole thing as an image you can attach to a task,
          a goal, or a meeting.
        </p>
      </header>

      {/* ── Create form ─────────────────────────────────────────── */}
      <SectionCard title="Create new board" testId="bulletin-create-section">
        <form
          data-testid="bulletin-create-form"
          onSubmit={handleCreate}
          style={{ display: "grid", gap: "0.75rem" }}
        >
          <label style={{ display: "grid", gap: 4 }}>
            <span
              style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}
            >
              Title <span style={{ color: "var(--wp-error)" }}>*</span>
            </span>
            <input
              data-testid="bulletin-create-title"
              type="text"
              required
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Q3 launch retrospective"
              style={inputStyle}
            />
          </label>
          <label style={{ display: "grid", gap: 4 }}>
            <span
              style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)" }}
            >
              Description (optional)
            </span>
            <input
              data-testid="bulletin-create-description"
              type="text"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What went well, what didn't, action items"
              style={inputStyle}
            />
          </label>
          {createError ? (
            <div
              data-testid="bulletin-create-error"
              style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}
            >
              {createError}
            </div>
          ) : null}
          <div>
            <button
              data-testid="bulletin-create-submit"
              type="submit"
              disabled={submitting}
              style={{
                ...btnPrimary,
                opacity: submitting ? 0.6 : 1,
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              {submitting ? "Creating…" : "Create board"}
            </button>
          </div>
        </form>
      </SectionCard>

      {/* ── Active boards ───────────────────────────────────────── */}
      <SectionCard title="Active boards" testId="bulletin-active-section">
        {loading ? (
          <div
            data-testid="bulletin-list-loading"
            style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}
          >
            Loading boards…
          </div>
        ) : loadError ? (
          <div
            data-testid="bulletin-list-error"
            style={{ color: "var(--wp-error)", fontSize: "0.85rem" }}
          >
            {loadError}
          </div>
        ) : active.length === 0 ? (
          <div
            data-testid="bulletin-list-empty"
            style={{ color: "var(--wp-text-muted)", fontSize: "0.9rem" }}
          >
            No boards yet — create one above.
          </div>
        ) : (
          <div
            data-testid="bulletin-list"
            role="table"
            style={{ display: "grid", gap: "0.5rem" }}
          >
            {active.map((b) => (
              <button
                key={b.id}
                data-testid={`bulletin-row-${b.id}`}
                type="button"
                onClick={() => navigateToBoard(b.id)}
                style={{
                  display: "grid",
                  gridTemplateColumns: "1fr auto",
                  gap: "0.75rem",
                  alignItems: "center",
                  textAlign: "left",
                  border: "1px solid var(--wp-dark-border)",
                  borderRadius: 8,
                  padding: "0.85rem 1rem",
                  background: "var(--wp-dark-surface2)",
                  color: "var(--wp-text)",
                  cursor: "pointer",
                  width: "100%",
                }}
              >
                <div style={{ minWidth: 0 }}>
                  <div
                    style={{
                      color: "var(--wp-text)",
                      fontWeight: 600,
                      fontSize: "0.95rem",
                    }}
                  >
                    {b.title}
                  </div>
                  {b.description ? (
                    <div
                      style={{
                        color: "var(--wp-text-dim)",
                        fontSize: "0.8rem",
                        marginTop: 2,
                      }}
                    >
                      {b.description}
                    </div>
                  ) : null}
                  <div
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--wp-text-muted)",
                      marginTop: 4,
                    }}
                  >
                    Updated {formatDate(b.updatedAt)}
                  </div>
                </div>
                {typeof b.noteCount === "number" ? (
                  <span
                    data-testid={`bulletin-row-notecount-${b.id}`}
                    style={{
                      fontSize: "0.75rem",
                      padding: "2px 10px",
                      borderRadius: 999,
                      background: "var(--wp-dark-border)",
                      color: "var(--wp-text)",
                    }}
                  >
                    {b.noteCount} note{b.noteCount === 1 ? "" : "s"}
                  </span>
                ) : null}
              </button>
            ))}
          </div>
        )}
      </SectionCard>

      {/* ── Archived (collapsible) ──────────────────────────────── */}
      <SectionCard
        title={`Archived${archived.length ? ` (${archived.length})` : ""}`}
        testId="bulletin-archived-section"
      >
        <button
          data-testid="bulletin-archived-toggle"
          type="button"
          onClick={() => setArchivedOpen((v) => !v)}
          style={{
            background: "transparent",
            border: "1px solid var(--wp-dark-border)",
            color: "var(--wp-text)",
            padding: "0.35rem 0.7rem",
            borderRadius: 6,
            fontSize: "0.75rem",
            cursor: "pointer",
            marginBottom: archivedOpen ? 12 : 0,
          }}
        >
          {archivedOpen ? "Hide archived" : "Show archived"}
        </button>
        {archivedOpen ? (
          archived.length === 0 ? (
            <div
              data-testid="bulletin-archived-empty"
              style={{ color: "var(--wp-text-muted)", fontSize: "0.85rem" }}
            >
              Nothing archived.
            </div>
          ) : (
            <div
              data-testid="bulletin-archived-list"
              style={{ display: "grid", gap: "0.5rem" }}
            >
              {archived.map((b) => (
                <button
                  key={b.id}
                  data-testid={`bulletin-archived-row-${b.id}`}
                  type="button"
                  onClick={() => navigateToBoard(b.id)}
                  style={{
                    textAlign: "left",
                    border: "1px solid var(--wp-dark-border)",
                    borderRadius: 8,
                    padding: "0.65rem 1rem",
                    background: "var(--wp-dark-surface2)",
                    color: "var(--wp-text-dim)",
                    cursor: "pointer",
                    width: "100%",
                  }}
                >
                  <div
                    style={{
                      fontWeight: 600,
                      fontSize: "0.9rem",
                    }}
                  >
                    {b.title}
                  </div>
                  {b.description ? (
                    <div style={{ fontSize: "0.75rem", marginTop: 2 }}>
                      {b.description}
                    </div>
                  ) : null}
                  <div
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--wp-text-muted)",
                      marginTop: 4,
                    }}
                  >
                    Archived {formatDate(b.archivedAt)}
                  </div>
                </button>
              ))}
            </div>
          )
        ) : null}
      </SectionCard>
    </div>
  );
}

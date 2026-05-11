"use client";

/**
 * /bulletin/[id] — interactive bulletin board.
 *
 * The canvas is a 16:10 relative-positioned div. Every note is an
 * absolutely-positioned sticky-note rectangle whose x/y/width/height are
 * stored as percentages of that canvas, so the layout reflows correctly
 * across screen sizes without re-saving anything.
 *
 * Drag, resize, color, and association changes are persisted via PATCH
 * /api/bulletin/notes/[id]; drag and resize are debounced 200ms so the
 * server doesn't see one PATCH per pixel.
 *
 * "Save as image" tries the SVG <foreignObject> trick first (works in
 * Chrome / Safari / Firefox for our content because we don't load any
 * cross-origin <img>). If the trick raises (some browsers reject
 * tainted canvases on blob.toDataURL), we fall back to manually drawing
 * each note onto an offscreen <canvas>. The fallback isn't pixel-perfect
 * but it's intentionally fine for v1 — the team uses this to attach
 * to-do screenshots to meeting notes.
 *
 * Auth: redirects to /login?next=/bulletin/[id] BEFORE any GET fires.
 *
 * Analytics: a single page-view fires on mount; everything else hangs
 * off the corresponding API call's analytics hook on the server.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  use,
} from "react";
import { createPortal } from "react-dom";
import {
  fetchWithRefresh,
  jsonHeaders,
  getInstinctToken,
} from "@/lib/client-auth";

/* ------------------------------------------------------------------ */
/* Types — mirror the documented API contract                          */
/* ------------------------------------------------------------------ */

type AssociationKind =
  | "task"
  | "goal"
  | "meeting"
  | "discussion"
  | "calendar_event";

interface Board {
  id: string;
  title: string;
  description: string | null;
  ownerUserId: string | null;
  archivedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Note {
  id: string;
  boardId: string;
  body: string;
  color: string;
  x_pct: number;
  y_pct: number;
  width_pct: number;
  height_pct: number;
  rotation_deg: number;
  /* Lib returns these in camelCase; the API forwards the lib row
     verbatim. The original spec used snake_case here which never
     matched what the server actually returned — confirmed by
     inspecting `BulletinNote` in src/lib/bulletin/notes.ts. */
  associationKind: AssociationKind | null;
  associationId: string | null;
  associationLabel: string | null;
  createdByUserId: string;
  createdByUserRole: string | null;
  createdByUserName: string | null;
  createdAt: string;
  updatedAt: string;
}

interface Snapshot {
  id: string;
  boardId: string;
  associationKind: AssociationKind | null;
  associationId: string | null;
  associationLabel: string | null;
  createdByUserId: string;
  createdAt: string;
}

interface AssocOption {
  id: string;
  label: string;
}

/* ------------------------------------------------------------------ */
/* Constants                                                            */
/* ------------------------------------------------------------------ */

const NOTE_COLORS: Array<{ value: string; label: string }> = [
  { value: "#FFE873", label: "Yellow" },
  { value: "#FFB6B6", label: "Pink" },
  { value: "#B6E3FF", label: "Blue" },
  { value: "#C5F0B6", label: "Green" },
  { value: "#E6BFFF", label: "Purple" },
  { value: "#FFD7A5", label: "Orange" },
];

const ASSOC_KINDS: Array<{ value: AssociationKind; label: string }> = [
  { value: "task", label: "Task" },
  { value: "goal", label: "Goal" },
  { value: "meeting", label: "Meeting" },
  { value: "discussion", label: "Discussion" },
  { value: "calendar_event", label: "Calendar event" },
];

/* Map kind → list endpoint + parser. We try in this order at runtime;
   if any 404s we fall back to manual id+label entry for that kind. */
const ASSOC_ENDPOINTS: Record<
  AssociationKind,
  { url: string; parse: (json: unknown) => AssocOption[] }
> = {
  task: {
    url: "/api/tasks?limit=50",
    parse: (json) => {
      const obj = json as { tasks?: Array<{ id: string; title: string }> };
      return (obj.tasks ?? []).map((t) => ({ id: t.id, label: t.title }));
    },
  },
  goal: {
    url: "/api/goals",
    parse: (json) => {
      const obj = json as {
        okrs?: Array<{ id: string; objective: string }>;
      };
      return (obj.okrs ?? []).map((g) => ({ id: g.id, label: g.objective }));
    },
  },
  meeting: {
    url: "/api/meetings",
    parse: (json) => {
      const obj = json as {
        transcripts?: Array<{ id: string; title: string | null }>;
      };
      return (obj.transcripts ?? []).map((m) => ({
        id: m.id,
        label: m.title || "Untitled meeting",
      }));
    },
  },
  discussion: {
    url: "/api/discussions",
    parse: (json) => {
      const obj = json as { threads?: Array<{ id: string; title: string }> };
      return (obj.threads ?? []).map((d) => ({ id: d.id, label: d.title }));
    },
  },
  calendar_event: {
    url: "/api/calendar/events?limit=50",
    parse: (json) => {
      const obj = json as {
        events?: Array<{ id: string; subject?: string; title?: string }>;
      };
      return (obj.events ?? []).map((e) => ({
        id: e.id,
        label: e.subject || e.title || "Untitled event",
      }));
    },
  },
};

/* ------------------------------------------------------------------ */
/* Helpers                                                              */
/* ------------------------------------------------------------------ */

function clampPct(v: number, min = 0, max = 100): number {
  if (!Number.isFinite(v)) return min;
  return Math.max(min, Math.min(max, v));
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return iso;
  }
}

/* Drawing helper for the snapshot fallback. Wraps text into multiple
   lines roughly fitting the given pixel width. */
function wrapText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
): string[] {
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

/* ------------------------------------------------------------------ */
/* Snapshot: render canvas → PNG base64                                */
/* ------------------------------------------------------------------ */

async function renderCanvasToPng(
  canvasEl: HTMLElement,
  notes: Note[],
): Promise<string> {
  const rect = canvasEl.getBoundingClientRect();
  const w = Math.max(800, Math.round(rect.width));
  const h = Math.max(500, Math.round(rect.height));

  /* ── try foreignObject first ──────────────────────────────────── */
  try {
    const xhtml = canvasEl.outerHTML
      .replace(/&/g, "&amp;")
      .replace(/<br>/g, "<br/>");
    const svg =
      `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}">` +
      `<foreignObject width="100%" height="100%">` +
      `<div xmlns="http://www.w3.org/1999/xhtml" style="width:${w}px;height:${h}px;background:#1a1a1a">` +
      xhtml +
      `</div></foreignObject></svg>`;
    const img = new Image();
    img.crossOrigin = "anonymous";
    const svgBlob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
    const svgUrl = URL.createObjectURL(svgBlob);
    try {
      await new Promise<void>((resolve, reject) => {
        img.onload = () => resolve();
        img.onerror = () => reject(new Error("svg image load failed"));
        img.src = svgUrl;
      });
      const off = document.createElement("canvas");
      off.width = w;
      off.height = h;
      const ctx = off.getContext("2d");
      if (!ctx) throw new Error("no 2d context");
      ctx.drawImage(img, 0, 0, w, h);
      const dataUrl = off.toDataURL("image/png");
      return dataUrl.replace(/^data:image\/png;base64,/, "");
    } finally {
      URL.revokeObjectURL(svgUrl);
    }
  } catch {
    /* fall through to manual fallback */
  }

  /* ── manual fallback: paint each note onto an offscreen canvas ── */
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  const ctx = off.getContext("2d");
  if (!ctx) throw new Error("Snapshot unsupported in this browser.");
  ctx.fillStyle = "#1a1a1a";
  ctx.fillRect(0, 0, w, h);

  for (const n of notes) {
    const nx = (n.x_pct / 100) * w;
    const ny = (n.y_pct / 100) * h;
    const nw = (n.width_pct / 100) * w;
    const nh = (n.height_pct / 100) * h;
    ctx.save();
    ctx.translate(nx + nw / 2, ny + nh / 2);
    ctx.rotate(((n.rotation_deg || 0) * Math.PI) / 180);
    ctx.fillStyle = n.color || "#FFE873";
    ctx.fillRect(-nw / 2, -nh / 2, nw, nh);
    ctx.fillStyle = "#222";
    ctx.font = "12px sans-serif";
    const lines = wrapText(ctx, n.body || "", nw - 12);
    let lineY = -nh / 2 + 18;
    for (const line of lines) {
      if (lineY > nh / 2 - 14) break;
      ctx.fillText(line, -nw / 2 + 8, lineY);
      lineY += 14;
    }
    if (n.createdByUserName) {
      ctx.font = "9px sans-serif";
      ctx.fillStyle = "#444";
      ctx.fillText(`— ${n.createdByUserName}`, -nw / 2 + 8, nh / 2 - 6);
    }
    ctx.restore();
  }
  const dataUrl = off.toDataURL("image/png");
  return dataUrl.replace(/^data:image\/png;base64,/, "");
}

/* ------------------------------------------------------------------ */
/* Page                                                                */
/* ------------------------------------------------------------------ */

export default function BulletinBoardPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id: boardId } = use(params);

  const [authChecked, setAuthChecked] = useState(false);
  const [board, setBoard] = useState<Board | null>(null);
  const [notes, setNotes] = useState<Note[]>([]);
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [titleDraft, setTitleDraft] = useState("");
  const [descDraft, setDescDraft] = useState("");
  const [savingMeta, setSavingMeta] = useState(false);

  const [activeNoteId, setActiveNoteId] = useState<string | null>(null);
  const [snapshotModalOpen, setSnapshotModalOpen] = useState(false);
  const [snapshotBusy, setSnapshotBusy] = useState(false);
  const [snapshotError, setSnapshotError] = useState<string | null>(null);

  // Snapshots sidebar collapsed state — persisted in localStorage so the
  // user's "more board, less sidebar" preference survives page reloads.
  const [snapshotsCollapsed, setSnapshotsCollapsed] = useState<boolean>(() => {
    if (typeof window === "undefined") return false;
    try {
      return window.localStorage.getItem("instinct.bulletin.snapshots_collapsed") === "1";
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(
        "instinct.bulletin.snapshots_collapsed",
        snapshotsCollapsed ? "1" : "0",
      );
    } catch {
      /* localStorage unavailable */
    }
  }, [snapshotsCollapsed]);

  const canvasRef = useRef<HTMLDivElement | null>(null);
  /* Per-note PATCH debounce timers. */
  const debounceTimers = useRef<Map<string, ReturnType<typeof setTimeout>>>(
    new Map(),
  );

  /* ── auth gate ────────────────────────────────────────────────── */
  useEffect(() => {
    if (!getInstinctToken()) {
      if (typeof window !== "undefined") {
        window.location.href = `/login?next=/bulletin/${encodeURIComponent(
          boardId,
        )}`;
      }
      return;
    }
    setAuthChecked(true);
  }, [boardId]);

  /* ── load ─────────────────────────────────────────────────────── */
  const loadBoard = useCallback(async () => {
    setLoading(true);
    setLoadError(null);
    try {
      const res = await fetchWithRefresh(
        `/api/bulletin/boards/${encodeURIComponent(boardId)}`,
      );
      if (!res.ok) {
        setLoadError(
          res.status === 404
            ? "Board not found."
            : "We couldn't load this board.",
        );
        return;
      }
      const data = (await res.json()) as {
        board: Board;
        notes: Note[];
        snapshots: Snapshot[];
      };
      setBoard(data.board);
      setNotes(Array.isArray(data.notes) ? data.notes : []);
      setSnapshots(Array.isArray(data.snapshots) ? data.snapshots : []);
      setTitleDraft(data.board.title);
      setDescDraft(data.board.description ?? "");
    } catch (err) {
      setLoadError(`Network error: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  }, [boardId]);

  useEffect(() => {
    if (!authChecked) return;
    void loadBoard();
  }, [authChecked, loadBoard]);

  /* ── live polling: shared bulletin board use during meetings ──────
     Boards are org-shared by data-model design (migration 113), but
     without polling each team member would see a stale snapshot until
     they refreshed. We poll the board detail every 5s and merge
     remote notes into local state, with these guardrails:
       1. Skip the poll entirely when the local user is mid-edit
          (a note is active, the snapshot modal is open, board meta
          is saving, or any per-note debounce timer is queued) so a
          remote refresh can't stomp typed-but-unsaved state.
       2. Skip the poll while the document is hidden — background
          tabs shouldn't fan out work to Postgres on a 5s cadence
          across the whole agency.
       3. Quiet refresh — `setLoading(false)` immediately, no flicker;
          on network error we just wait for the next interval.
     The /api/bulletin/boards/[id] GET is org-shared and emits no
     analytics on the read path, so polling is safe to run cheaply. */
  useEffect(() => {
    if (!authChecked) return;
    if (typeof window === "undefined") return;

    const POLL_MS = 5_000;

    async function pollOnce() {
      if (typeof document !== "undefined" && document.hidden) return;
      /* Local-edit guards — skip if anything could clobber. */
      if (activeNoteId !== null) return;
      if (snapshotModalOpen) return;
      if (savingMeta) return;
      if (debounceTimers.current.size > 0) return;

      try {
        const res = await fetchWithRefresh(
          `/api/bulletin/boards/${encodeURIComponent(boardId)}`,
        );
        if (!res.ok) return;
        const data = (await res.json()) as {
          board: Board;
          notes: Note[];
          snapshots: Snapshot[];
        };
        /* Replace state only when we have a successful payload. The
           note list, board meta, and snapshot index can all change
           between users — replace each. The shape comes from the
           same endpoint as the initial load so the ordering and
           filtering rules already match the canvas. */
        setBoard((prev) => {
          if (
            prev &&
            prev.title === data.board.title &&
            prev.description === data.board.description &&
            prev.archivedAt === data.board.archivedAt &&
            prev.updatedAt === data.board.updatedAt
          ) {
            return prev;
          }
          return data.board;
        });
        setNotes((prev) => {
          /* Cheap fingerprint — if the count and per-id updatedAt
             stamps match, skip the setState to avoid re-renders. */
          if (prev.length === data.notes.length) {
            const prevById = new Map(prev.map((n) => [n.id, n.updatedAt]));
            const same = data.notes.every(
              (n) => prevById.get(n.id) === n.updatedAt,
            );
            if (same) return prev;
          }
          return data.notes;
        });
        setSnapshots((prev) => {
          if (prev.length === data.snapshots.length) {
            const prevIds = new Set(prev.map((s) => s.id));
            if (data.snapshots.every((s) => prevIds.has(s.id))) return prev;
          }
          return data.snapshots;
        });
      } catch {
        /* Network blip — wait for next tick. */
      }
    }

    const interval = window.setInterval(() => {
      void pollOnce();
    }, POLL_MS);
    return () => window.clearInterval(interval);
  }, [
    authChecked,
    boardId,
    activeNoteId,
    snapshotModalOpen,
    savingMeta,
  ]);

  /* ── meta save ────────────────────────────────────────────────── */
  async function saveMeta(patch: { title?: string; description?: string }) {
    setSavingMeta(true);
    try {
      const res = await fetchWithRefresh(
        `/api/bulletin/boards/${encodeURIComponent(boardId)}`,
        {
          method: "PATCH",
          headers: jsonHeaders(),
          body: JSON.stringify(patch),
        },
      );
      if (!res.ok) return;
      const data = (await res.json()) as { board: Board };
      setBoard(data.board);
    } finally {
      setSavingMeta(false);
    }
  }

  /* ── notes: add ───────────────────────────────────────────────── */
  async function addNote(color: string) {
    /* Drop the new note centered, slightly randomized so multiple in a
       row don't perfectly overlap. */
    const x = 35 + Math.random() * 10;
    const y = 30 + Math.random() * 10;
    const body = {
      body: "",
      color,
      position: {
        x_pct: x,
        y_pct: y,
        width_pct: 18,
        height_pct: 18,
        rotation_deg: Math.round((Math.random() - 0.5) * 8),
      },
    };
    const res = await fetchWithRefresh(
      `/api/bulletin/boards/${encodeURIComponent(boardId)}/notes`,
      {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) return;
    const data = (await res.json()) as { note: Note };
    setNotes((prev) => [...prev, data.note]);
    setActiveNoteId(data.note.id);
  }

  /* ── notes: patch (debounced for high-frequency updates) ────────── */
  /* The PATCH endpoint accepts the in-memory note fields PLUS an
     `association: {kind,id,label}|null` setter (which the server
     translates into the three association_* columns). The Partial<Note>
     type doesn't carry that setter, so we widen here. */
  type NotePatchInput = Partial<Note> & {
    association?:
      | { kind: AssociationKind; id: string; label: string }
      | null;
  };
  function patchNoteServer(id: string, patch: NotePatchInput): Promise<void> {
    return fetchWithRefresh(
      `/api/bulletin/notes/${encodeURIComponent(id)}`,
      {
        method: "PATCH",
        headers: jsonHeaders(),
        body: JSON.stringify(patch),
      },
    )
      .then(async (res) => {
        if (!res.ok) return;
        const data = (await res.json().catch(() => ({}))) as {
          note?: Note;
        };
        if (data.note) {
          setNotes((prev) =>
            prev.map((n) => (n.id === id ? { ...n, ...data.note } : n)),
          );
        }
      })
      .catch(() => undefined);
  }

  function patchNoteOptimistic(id: string, patch: Partial<Note>) {
    setNotes((prev) =>
      prev.map((n) => (n.id === id ? { ...n, ...patch } : n)),
    );
  }

  function patchNoteDebounced(id: string, patch: Partial<Note>, ms = 200) {
    const existing = debounceTimers.current.get(id);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      void patchNoteServer(id, patch);
      debounceTimers.current.delete(id);
    }, ms);
    debounceTimers.current.set(id, t);
  }

  /* ── notes: delete ────────────────────────────────────────────── */
  async function deleteNote(id: string) {
    const res = await fetchWithRefresh(
      `/api/bulletin/notes/${encodeURIComponent(id)}`,
      { method: "DELETE" },
    );
    if (!res.ok) return;
    setNotes((prev) => prev.filter((n) => n.id !== id));
    if (activeNoteId === id) setActiveNoteId(null);
  }

  /* ── archive board ────────────────────────────────────────────── */
  async function archiveBoard() {
    if (typeof window !== "undefined") {
      const ok = window.confirm(
        "Archive this board? It'll move to the Archived section but isn't deleted.",
      );
      if (!ok) return;
    }
    const res = await fetchWithRefresh(
      `/api/bulletin/boards/${encodeURIComponent(boardId)}`,
      { method: "DELETE" },
    );
    if (!res.ok) return;
    if (typeof window !== "undefined") {
      window.location.href = "/bulletin";
    }
  }

  /* ── snapshot ─────────────────────────────────────────────────── */
  const [snapAssocKind, setSnapAssocKind] = useState<AssociationKind | "">(
    "",
  );
  const [snapAssocId, setSnapAssocId] = useState("");
  const [snapAssocLabel, setSnapAssocLabel] = useState("");

  async function saveSnapshot() {
    if (!canvasRef.current) return;
    setSnapshotBusy(true);
    setSnapshotError(null);
    try {
      const png_base64 = await renderCanvasToPng(canvasRef.current, notes);
      const body: {
        png_base64: string;
        association?: {
          kind: AssociationKind;
          id: string;
          label: string;
        };
      } = { png_base64 };
      if (snapAssocKind && snapAssocId) {
        body.association = {
          kind: snapAssocKind,
          id: snapAssocId,
          label: snapAssocLabel || snapAssocId,
        };
      }
      const res = await fetchWithRefresh(
        `/api/bulletin/boards/${encodeURIComponent(boardId)}/snapshot`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const errBody = (await res.json().catch(() => ({}))) as {
          error?: string;
        };
        setSnapshotError(
          errBody.error
            ? `Save failed (${res.status}): ${errBody.error}`
            : `Save failed (${res.status})`,
        );
        return;
      }
      const data = (await res.json()) as { snapshot: Snapshot };
      setSnapshots((prev) => [data.snapshot, ...prev]);
      setSnapshotModalOpen(false);
      setSnapAssocKind("");
      setSnapAssocId("");
      setSnapAssocLabel("");
    } catch (err) {
      setSnapshotError(`Snapshot failed: ${(err as Error).message}`);
    } finally {
      setSnapshotBusy(false);
    }
  }

  /* ── render ───────────────────────────────────────────────────── */
  if (!authChecked) {
    return (
      <div
        data-testid="bulletin-board-loading"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Loading…
      </div>
    );
  }

  if (loading) {
    return (
      <div
        data-testid="bulletin-board-loading"
        style={{ color: "var(--wp-text-dim)" }}
      >
        Loading board…
      </div>
    );
  }

  if (loadError || !board) {
    return (
      <div
        data-testid="bulletin-board-error"
        style={{ color: "var(--wp-error)" }}
      >
        {loadError || "Board not available."}
      </div>
    );
  }

  return (
    <div
      data-testid="bulletin-board-page"
      style={{
        display: "grid",
        gridTemplateColumns: snapshotsCollapsed ? "1fr 40px" : "1fr 280px",
        gap: "1rem",
        maxWidth: "100%",
        minWidth: 0,
        padding: "0 1rem",
        transition: "grid-template-columns 180ms ease-out",
      }}
    >
      <style jsx global>{`
        @media (max-width: 900px) {
          [data-testid="bulletin-board-page"] {
            grid-template-columns: 1fr !important;
          }
          [data-testid="bulletin-snapshot-sidebar"] {
            order: 2;
          }
        }
        .bulletin-canvas {
          position: relative;
          width: 100%;
          aspect-ratio: 16 / 10;
          background: #1a1a1a;
          background-image:
            linear-gradient(rgba(255, 255, 255, 0.03) 1px, transparent 1px),
            linear-gradient(90deg, rgba(255, 255, 255, 0.03) 1px, transparent 1px);
          background-size: 40px 40px;
          border: 1px solid var(--wp-dark-border);
          border-radius: 8px;
          overflow: hidden;
          touch-action: none;
        }
        .bulletin-note {
          position: absolute;
          box-shadow: 0 4px 8px rgba(0, 0, 0, 0.3);
          color: #222;
          font-size: 0.85rem;
          padding: 8px 10px 22px 10px;
          box-sizing: border-box;
          user-select: none;
          cursor: grab;
          overflow: hidden;
          font-family: "Comic Sans MS", "Marker Felt", cursive;
        }
        .bulletin-note:active {
          cursor: grabbing;
        }
        .bulletin-note textarea {
          width: 100%;
          height: 100%;
          background: transparent;
          border: none;
          color: inherit;
          font: inherit;
          resize: none;
          outline: none;
          font-family: inherit;
        }
        .bulletin-resize {
          position: absolute;
          right: 0;
          bottom: 0;
          width: 14px;
          height: 14px;
          background: rgba(0, 0, 0, 0.25);
          cursor: nwse-resize;
        }
      `}</style>

      <div style={{ minWidth: 0 }}>
        {/* Toolbar */}
        <div
          data-testid="bulletin-board-toolbar"
          style={{
            display: "flex",
            gap: "0.5rem",
            flexWrap: "wrap",
            alignItems: "center",
            marginBottom: "0.75rem",
          }}
        >
          <input
            data-testid="bulletin-board-title-input"
            type="text"
            value={titleDraft}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={() => {
              if (titleDraft.trim() && titleDraft !== board.title) {
                void saveMeta({ title: titleDraft.trim() });
              }
            }}
            style={{
              background: "transparent",
              border: "1px solid transparent",
              color: "var(--wp-gold)",
              fontSize: "1.25rem",
              fontWeight: 700,
              padding: "0.25rem 0.5rem",
              borderRadius: 6,
              flex: "1 1 200px",
              minWidth: 0,
            }}
          />
          <AddNoteButton onPick={(c) => void addNote(c)} />
          <button
            data-testid="bulletin-snapshot-open"
            type="button"
            onClick={() => setSnapshotModalOpen(true)}
            style={{
              background: "transparent",
              border: "1px solid var(--wp-gold)",
              color: "var(--wp-gold)",
              padding: "0.4rem 0.8rem",
              borderRadius: 6,
              fontSize: "0.8rem",
              cursor: "pointer",
              fontWeight: 600,
            }}
          >
            Save as image
          </button>
          <button
            data-testid="bulletin-archive-board"
            type="button"
            onClick={archiveBoard}
            style={{
              background: "transparent",
              border: "1px solid var(--wp-error)",
              color: "var(--wp-error)",
              padding: "0.4rem 0.8rem",
              borderRadius: 6,
              fontSize: "0.8rem",
              cursor: "pointer",
            }}
          >
            Archive board
          </button>
        </div>
        <input
          data-testid="bulletin-board-description-input"
          type="text"
          value={descDraft}
          placeholder="Describe what this board is for"
          onChange={(e) => setDescDraft(e.target.value)}
          onBlur={() => {
            if (descDraft !== (board.description ?? "")) {
              void saveMeta({ description: descDraft });
            }
          }}
          style={{
            background: "var(--wp-dark)",
            border: "1px solid var(--wp-dark-border)",
            color: "var(--wp-text-dim)",
            fontSize: "0.85rem",
            padding: "0.4rem 0.6rem",
            borderRadius: 6,
            width: "100%",
            marginBottom: "0.75rem",
          }}
        />
        {savingMeta ? (
          <span
            style={{
              color: "var(--wp-text-muted)",
              fontSize: "0.7rem",
              marginLeft: 4,
            }}
          >
            Saving…
          </span>
        ) : null}

        {/* Canvas */}
        <div
          ref={canvasRef}
          data-testid="bulletin-canvas"
          className="bulletin-canvas"
        >
          {notes.map((n) => (
            <NoteView
              key={n.id}
              note={n}
              active={activeNoteId === n.id}
              onActivate={() => setActiveNoteId(n.id)}
              onDeactivate={() => {
                if (activeNoteId === n.id) setActiveNoteId(null);
              }}
              onPatchOptimistic={patchNoteOptimistic}
              onPatchDebounced={patchNoteDebounced}
              onPatchImmediate={patchNoteServer}
              onDelete={() => void deleteNote(n.id)}
              canvasRef={canvasRef}
            />
          ))}
          {notes.length === 0 ? (
            <div
              data-testid="bulletin-canvas-empty"
              style={{
                position: "absolute",
                inset: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "var(--wp-text-muted)",
                fontSize: "0.9rem",
                pointerEvents: "none",
              }}
            >
              Empty board — click "Add note" to drop your first sticky.
            </div>
          ) : null}
        </div>
      </div>

      {/* Snapshots sidebar — collapsible. When collapsed, renders a thin
          40px strip with just the toggle button so the board canvas
          reclaims ~240px of horizontal space. */}
      <aside
        data-testid="bulletin-snapshot-sidebar"
        data-collapsed={snapshotsCollapsed ? "true" : "false"}
        style={{
          background: "var(--wp-dark-surface)",
          borderRadius: 8,
          border: "1px solid var(--wp-dark-border)",
          padding: snapshotsCollapsed ? "0.5rem 0.25rem" : "0.75rem",
          height: "fit-content",
          overflow: "hidden",
          minWidth: 0,
        }}
      >
        {snapshotsCollapsed ? (
          <button
            type="button"
            data-testid="bulletin-snapshot-sidebar-expand"
            aria-label="Expand saved snapshots"
            title="Expand saved snapshots"
            onClick={() => setSnapshotsCollapsed(false)}
            style={{
              background: "transparent",
              border: "none",
              cursor: "pointer",
              color: "var(--wp-gold)",
              fontSize: "1rem",
              padding: "0.25rem 0",
              width: "100%",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              writingMode: "vertical-rl",
            }}
          >
            « Snapshots ({snapshots.length})
          </button>
        ) : (
        <>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.5rem",
            gap: "0.5rem",
          }}
        >
          <h3
            style={{
              color: "var(--wp-gold)",
              fontSize: "0.85rem",
              margin: 0,
              fontWeight: 600,
            }}
          >
            Saved snapshots
          </h3>
          <button
            type="button"
            data-testid="bulletin-snapshot-sidebar-collapse"
            aria-label="Minimize saved snapshots"
            title="Minimize saved snapshots (more board space)"
            onClick={() => setSnapshotsCollapsed(true)}
            style={{
              background: "transparent",
              border: "1px solid var(--wp-dark-border)",
              borderRadius: 4,
              color: "var(--wp-text-dim)",
              cursor: "pointer",
              fontSize: "0.8rem",
              padding: "0 0.4rem",
              lineHeight: "1.3rem",
            }}
          >
            »
          </button>
        </div>
        {snapshots.length === 0 ? (
          <div
            data-testid="bulletin-snapshot-empty"
            style={{ color: "var(--wp-text-muted)", fontSize: "0.75rem" }}
          >
            No snapshots yet — click "Save as image" to capture one.
          </div>
        ) : (
          <ul
            data-testid="bulletin-snapshot-list"
            style={{
              listStyle: "none",
              margin: 0,
              padding: 0,
              display: "grid",
              gap: "0.5rem",
            }}
          >
            {snapshots.map((s) => (
              <li
                key={s.id}
                data-testid={`bulletin-snapshot-row-${s.id}`}
                style={{
                  border: "1px solid var(--wp-dark-border)",
                  borderRadius: 6,
                  padding: "0.5rem",
                  fontSize: "0.75rem",
                  color: "var(--wp-text-dim)",
                }}
              >
                <div>{formatDate(s.createdAt)}</div>
                {s.associationLabel ? (
                  <div
                    style={{
                      color: "var(--wp-text)",
                      fontSize: "0.7rem",
                      marginTop: 2,
                    }}
                  >
                    [{s.associationKind}] {s.associationLabel}
                  </div>
                ) : null}
                <div style={{ display: "flex", gap: 6, marginTop: 6 }}>
                  <a
                    data-testid={`bulletin-snapshot-view-${s.id}`}
                    href={`/api/bulletin/snapshots/${encodeURIComponent(
                      s.id,
                    )}/png`}
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: "var(--wp-gold)" }}
                  >
                    View
                  </a>
                  <a
                    data-testid={`bulletin-snapshot-download-${s.id}`}
                    href={`/api/bulletin/snapshots/${encodeURIComponent(
                      s.id,
                    )}/png`}
                    download={`bulletin-snapshot-${s.id}.png`}
                    style={{ color: "var(--wp-gold)" }}
                  >
                    Download
                  </a>
                </div>
              </li>
            ))}
          </ul>
        )}
        </>
        )}
      </aside>

      {/* Snapshot modal */}
      {snapshotModalOpen ? (
        <div
          data-testid="bulletin-snapshot-modal"
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.6)",
            zIndex: 50,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            padding: "1rem",
          }}
          onClick={(e) => {
            if (e.target === e.currentTarget) setSnapshotModalOpen(false);
          }}
        >
          <div
            style={{
              background: "var(--wp-dark-surface)",
              border: "1px solid var(--wp-dark-border)",
              borderRadius: 8,
              padding: "1.25rem",
              minWidth: 320,
              maxWidth: 440,
              width: "100%",
            }}
          >
            <h3
              style={{
                margin: 0,
                color: "var(--wp-gold)",
                fontSize: "1rem",
                marginBottom: "0.75rem",
              }}
            >
              Save snapshot
            </h3>
            <p
              style={{
                fontSize: "0.8rem",
                color: "var(--wp-text-dim)",
                marginBottom: "0.75rem",
              }}
            >
              Captures the current canvas as a PNG. Optionally tag it
              with what it relates to.
            </p>
            <AssociationPicker
              kind={snapAssocKind || null}
              id={snapAssocId}
              label={snapAssocLabel}
              onChange={(p) => {
                setSnapAssocKind(p.kind || "");
                setSnapAssocId(p.id);
                setSnapAssocLabel(p.label);
              }}
              testIdPrefix="bulletin-snapshot-assoc"
            />
            {snapshotError ? (
              <div
                data-testid="bulletin-snapshot-error"
                style={{
                  color: "var(--wp-error)",
                  fontSize: "0.8rem",
                  marginTop: "0.5rem",
                }}
              >
                {snapshotError}
              </div>
            ) : null}
            <div
              style={{
                display: "flex",
                gap: 8,
                marginTop: "1rem",
                justifyContent: "flex-end",
              }}
            >
              <button
                data-testid="bulletin-snapshot-cancel"
                type="button"
                onClick={() => setSnapshotModalOpen(false)}
                style={{
                  background: "transparent",
                  border: "1px solid var(--wp-dark-border)",
                  color: "var(--wp-text)",
                  padding: "0.4rem 0.8rem",
                  borderRadius: 6,
                  fontSize: "0.8rem",
                  cursor: "pointer",
                }}
              >
                Cancel
              </button>
              <button
                data-testid="bulletin-snapshot-save"
                type="button"
                disabled={snapshotBusy}
                onClick={saveSnapshot}
                style={{
                  background: "var(--wp-gold)",
                  color: "#000",
                  border: "none",
                  padding: "0.4rem 0.8rem",
                  borderRadius: 6,
                  fontSize: "0.8rem",
                  fontWeight: 600,
                  cursor: snapshotBusy ? "wait" : "pointer",
                  opacity: snapshotBusy ? 0.6 : 1,
                }}
              >
                {snapshotBusy ? "Saving…" : "Save snapshot"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AddNoteButton — dropdown of color swatches                          */
/* ------------------------------------------------------------------ */

function AddNoteButton({ onPick }: { onPick: (color: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ position: "relative" }}>
      <button
        data-testid="bulletin-add-note"
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
          background: "var(--wp-gold)",
          color: "#000",
          border: "none",
          padding: "0.4rem 0.8rem",
          borderRadius: 6,
          fontSize: "0.8rem",
          cursor: "pointer",
          fontWeight: 600,
        }}
      >
        + Add note
      </button>
      {open ? (
        <div
          data-testid="bulletin-add-note-palette"
          style={{
            position: "absolute",
            top: "calc(100% + 4px)",
            left: 0,
            background: "var(--wp-dark-surface)",
            border: "1px solid var(--wp-dark-border)",
            borderRadius: 6,
            padding: "0.5rem",
            display: "flex",
            gap: 4,
            zIndex: 5,
          }}
        >
          {NOTE_COLORS.map((c) => (
            <button
              key={c.value}
              data-testid={`bulletin-add-note-color-${c.value}`}
              type="button"
              onClick={() => {
                onPick(c.value);
                setOpen(false);
              }}
              title={c.label}
              style={{
                width: 24,
                height: 24,
                borderRadius: 4,
                border: "1px solid rgba(0,0,0,0.2)",
                background: c.value,
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* NoteView — single sticky-note rectangle with drag/resize/edit       */
/* ------------------------------------------------------------------ */

function NoteView({
  note,
  active,
  onActivate,
  onDeactivate,
  onPatchOptimistic,
  onPatchDebounced,
  onPatchImmediate,
  onDelete,
  canvasRef,
}: {
  note: Note;
  active: boolean;
  onActivate: () => void;
  onDeactivate: () => void;
  onPatchOptimistic: (id: string, patch: Partial<Note>) => void;
  // patchNoteServer accepts a wider input that includes the server's
  // `association` setter; cast at the call site.
  onPatchDebounced: (id: string, patch: Partial<Note>, ms?: number) => void;
  onPatchImmediate: (
    id: string,
    patch: Partial<Note> & {
      association?:
        | { kind: AssociationKind; id: string; label: string }
        | null;
    },
  ) => Promise<void>;
  onDelete: () => void;
  canvasRef: React.RefObject<HTMLDivElement | null>;
}) {
  const [editing, setEditing] = useState(false);
  const [bodyDraft, setBodyDraft] = useState(note.body);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [assocOpen, setAssocOpen] = useState(false);

  useEffect(() => {
    setBodyDraft(note.body);
  }, [note.body]);

  /* Drag */
  function onPointerDownDrag(e: React.PointerEvent) {
    if (editing) return;
    const target = e.target as HTMLElement;
    /* Don't start a drag from the resize handle, delete button, or palette. */
    if (target.dataset.role === "resize") return;
    if (target.dataset.role === "noninteractive") return;
    e.preventDefault();
    const startX = e.clientX;
    const startY = e.clientY;
    const startPctX = note.x_pct;
    const startPctY = note.y_pct;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    function onMove(ev: PointerEvent) {
      const dxPct = ((ev.clientX - startX) / rect.width) * 100;
      const dyPct = ((ev.clientY - startY) / rect.height) * 100;
      const nx = clampPct(startPctX + dxPct, 0, 100 - note.width_pct);
      const ny = clampPct(startPctY + dyPct, 0, 100 - note.height_pct);
      onPatchOptimistic(note.id, { x_pct: nx, y_pct: ny });
      onPatchDebounced(note.id, { x_pct: nx, y_pct: ny });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    onActivate();
  }

  /* Resize */
  function onPointerDownResize(e: React.PointerEvent) {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startY = e.clientY;
    const startW = note.width_pct;
    const startH = note.height_pct;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();

    function onMove(ev: PointerEvent) {
      const dwPct = ((ev.clientX - startX) / rect.width) * 100;
      const dhPct = ((ev.clientY - startY) / rect.height) * 100;
      const nw = clampPct(startW + dwPct, 8, 100 - note.x_pct);
      const nh = clampPct(startH + dhPct, 8, 100 - note.y_pct);
      onPatchOptimistic(note.id, { width_pct: nw, height_pct: nh });
      onPatchDebounced(note.id, { width_pct: nw, height_pct: nh });
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  }

  function onTextBlur() {
    setEditing(false);
    onDeactivate();
    if (bodyDraft !== note.body) {
      onPatchOptimistic(note.id, { body: bodyDraft });
      void onPatchImmediate(note.id, { body: bodyDraft });
    }
  }

  function changeColor(color: string) {
    onPatchOptimistic(note.id, { color });
    void onPatchImmediate(note.id, { color });
    setPaletteOpen(false);
  }

  function setAssociation(p: {
    kind: AssociationKind | null;
    id: string;
    label: string;
  }) {
    /* Optimistic — local state still uses camelCase fields per the
       lib's response shape. */
    onPatchOptimistic(note.id, {
      associationKind: p.kind,
      associationId: p.kind ? p.id : null,
      associationLabel: p.kind ? p.label : null,
    });
    /* AssociationPicker fires onChange twice when the user starts a
       fresh link: once when the kind dropdown changes (kind="task",
       id=""), and again once they pick the actual record. Skip the
       server PATCH on the kind-only step — the route requires a
       non-empty id and would 400. The follow-up call with the picked
       id persists the association. */
    if (p.kind && !p.id) return;
    /* Server PATCH — endpoint expects `association: {kind,id,label} | null`
       (verified in src/app/api/bulletin/notes/[id]/route.ts). */
    void onPatchImmediate(note.id, {
      association: p.kind
        ? { kind: p.kind, id: p.id, label: p.label }
        : null,
    });
  }

  return (
    <div
      data-testid={`bulletin-note-${note.id}`}
      className="bulletin-note"
      onPointerDown={onPointerDownDrag}
      onClick={() => onActivate()}
      style={{
        left: `${note.x_pct}%`,
        top: `${note.y_pct}%`,
        width: `${note.width_pct}%`,
        height: `${note.height_pct}%`,
        background: note.color || "#FFE873",
        transform: `rotate(${note.rotation_deg || 0}deg)`,
        zIndex: active ? 4 : 2,
        outline: active ? "2px solid var(--wp-gold)" : "none",
      }}
    >
      <button
        data-testid={`bulletin-note-delete-${note.id}`}
        type="button"
        data-role="noninteractive"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        style={{
          position: "absolute",
          top: 2,
          right: 4,
          width: 18,
          height: 18,
          borderRadius: 9,
          border: "none",
          background: "rgba(0,0,0,0.15)",
          color: "#222",
          fontSize: 12,
          fontWeight: 700,
          cursor: "pointer",
          lineHeight: 1,
        }}
        aria-label="Delete note"
      >
        ×
      </button>

      {editing ? (
        <textarea
          data-testid={`bulletin-note-textarea-${note.id}`}
          autoFocus
          value={bodyDraft}
          onChange={(e) => setBodyDraft(e.target.value)}
          onBlur={onTextBlur}
          onPointerDown={(e) => e.stopPropagation()}
        />
      ) : (
        <div
          data-testid={`bulletin-note-body-${note.id}`}
          onDoubleClick={() => setEditing(true)}
          onClick={(e) => {
            if (active) {
              e.stopPropagation();
              setEditing(true);
            }
          }}
          style={{
            width: "100%",
            height: "100%",
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            overflow: "hidden",
          }}
        >
          {note.body || (
            <span style={{ color: "rgba(0,0,0,0.4)" }}>
              Click to edit…
            </span>
          )}
        </div>
      )}

      {/* footer: author + actions */}
      <div
        data-role="noninteractive"
        style={{
          position: "absolute",
          left: 6,
          right: 22,
          bottom: 2,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontSize: 9,
          color: "rgba(0,0,0,0.6)",
        }}
      >
        <div style={{ display: "flex", gap: 4 }}>
          <button
            data-testid={`bulletin-note-color-toggle-${note.id}`}
            data-role="noninteractive"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setPaletteOpen((v) => !v);
            }}
            style={{
              background: "rgba(0,0,0,0.15)",
              color: "#222",
              border: "none",
              borderRadius: 3,
              padding: "1px 4px",
              fontSize: 9,
              cursor: "pointer",
            }}
          >
            color
          </button>
          <button
            data-testid={`bulletin-note-assoc-toggle-${note.id}`}
            data-role="noninteractive"
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              setAssocOpen((v) => !v);
            }}
            style={{
              background: "rgba(0,0,0,0.15)",
              color: "#222",
              border: "none",
              borderRadius: 3,
              padding: "1px 4px",
              fontSize: 9,
              cursor: "pointer",
            }}
          >
            {note.associationLabel ? "linked" : "link"}
          </button>
        </div>
        <span
          data-testid={`bulletin-note-author-${note.id}`}
          style={{ overflow: "hidden", textOverflow: "ellipsis" }}
        >
          {note.createdByUserName || ""}
        </span>
      </div>

      {paletteOpen ? (
        <div
          data-testid={`bulletin-note-palette-${note.id}`}
          data-role="noninteractive"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
          style={{
            position: "absolute",
            bottom: 16,
            left: 4,
            display: "flex",
            gap: 3,
            background: "rgba(0,0,0,0.7)",
            padding: 4,
            borderRadius: 4,
          }}
        >
          {NOTE_COLORS.map((c) => (
            <button
              key={c.value}
              data-testid={`bulletin-note-color-${note.id}-${c.value}`}
              data-role="noninteractive"
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                changeColor(c.value);
              }}
              title={c.label}
              style={{
                width: 16,
                height: 16,
                background: c.value,
                border: "1px solid rgba(255,255,255,0.5)",
                borderRadius: 2,
                cursor: "pointer",
              }}
            />
          ))}
        </div>
      ) : null}

      {assocOpen && typeof document !== "undefined"
        ? createPortal(
            /* Portal to document.body — the note has `transform: rotate()`
               which becomes a containing block for ALL positioned
               descendants (even position:fixed). The picker rendered
               inline ended up tilted, tiny, and partly off-screen on
               mobile. A portal escapes the transform context entirely
               and lets us render a proper centered sheet. */
            <div
              data-role="noninteractive"
              onPointerDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                if (e.target === e.currentTarget) setAssocOpen(false);
              }}
              style={{
                position: "fixed",
                inset: 0,
                background: "rgba(0,0,0,0.55)",
                zIndex: 100,
                display: "flex",
                alignItems: "flex-end",
                justifyContent: "center",
                padding: "1rem",
              }}
            >
              <div
                data-testid={`bulletin-note-assoc-panel-${note.id}`}
                style={{
                  background: "var(--wp-dark-surface)",
                  border: "1px solid var(--wp-dark-border)",
                  borderRadius: 8,
                  padding: "1rem",
                  width: "100%",
                  maxWidth: 480,
                  maxHeight: "70vh",
                  overflowY: "auto",
                  fontSize: "0.95rem",
                }}
              >
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    marginBottom: 8,
                  }}
                >
                  <strong style={{ color: "var(--wp-gold)" }}>
                    Link this note
                  </strong>
                  <button
                    type="button"
                    data-testid={`bulletin-note-assoc-close-${note.id}`}
                    onClick={() => setAssocOpen(false)}
                    style={{
                      background: "transparent",
                      color: "var(--wp-text)",
                      border: "1px solid var(--wp-dark-border)",
                      borderRadius: 4,
                      padding: "2px 10px",
                      fontSize: 13,
                      cursor: "pointer",
                    }}
                  >
                    Close
                  </button>
                </div>
                <AssociationPicker
                  kind={note.associationKind}
                  id={note.associationId || ""}
                  label={note.associationLabel || ""}
                  onChange={setAssociation}
                  testIdPrefix={`bulletin-note-assoc-${note.id}`}
                />
              </div>
            </div>,
            document.body,
          )
        : null}

      <div
        className="bulletin-resize"
        data-role="resize"
        data-testid={`bulletin-note-resize-${note.id}`}
        onPointerDown={onPointerDownResize}
      />
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* AssociationPicker — kind + id picker, with best-effort list fetch   */
/* and a manual fallback when an endpoint isn't available.              */
/* ------------------------------------------------------------------ */

function AssociationPicker({
  kind,
  id,
  label,
  onChange,
  testIdPrefix,
}: {
  kind: AssociationKind | null;
  id: string;
  label: string;
  onChange: (p: {
    kind: AssociationKind | null;
    id: string;
    label: string;
  }) => void;
  testIdPrefix: string;
}) {
  const [options, setOptions] = useState<AssocOption[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [endpointAvailable, setEndpointAvailable] = useState<boolean | null>(
    null,
  );
  const [manualId, setManualId] = useState(id);
  const [manualLabel, setManualLabel] = useState(label);

  /* When the kind changes, fetch its list. We treat any non-200 as
     "endpoint not available" → fall back to manual entry. */
  useEffect(() => {
    if (!kind) {
      setOptions(null);
      setEndpointAvailable(null);
      return;
    }
    setLoading(true);
    setOptions(null);
    setEndpointAvailable(null);
    const cfg = ASSOC_ENDPOINTS[kind];
    void (async () => {
      try {
        const res = await fetchWithRefresh(cfg.url);
        if (!res.ok) {
          setEndpointAvailable(false);
          return;
        }
        const json = await res.json();
        const opts = cfg.parse(json);
        setOptions(opts);
        setEndpointAvailable(true);
      } catch {
        setEndpointAvailable(false);
      } finally {
        setLoading(false);
      }
    })();
  }, [kind]);

  return (
    <div
      data-testid={testIdPrefix}
      style={{
        display: "grid",
        gap: 6,
        fontSize: "0.75rem",
        minWidth: 0,
        maxWidth: "100%",
      }}
    >
      <label style={{ display: "grid", gap: 2, minWidth: 0 }}>
        <span style={{ color: "var(--wp-text-dim)" }}>Associate with</span>
        <select
          data-testid={`${testIdPrefix}-kind`}
          value={kind ?? ""}
          onChange={(e) => {
            const k = e.target.value as AssociationKind | "";
            if (!k) {
              onChange({ kind: null, id: "", label: "" });
            } else {
              onChange({ kind: k, id: "", label: "" });
            }
          }}
          style={{
            background: "var(--wp-dark)",
            border: "1px solid var(--wp-dark-border)",
            color: "var(--wp-text)",
            borderRadius: 4,
            padding: "3px 6px",
            fontSize: "0.75rem",
          }}
        >
          <option value="">— none —</option>
          {ASSOC_KINDS.map((k) => (
            <option key={k.value} value={k.value}>
              {k.label}
            </option>
          ))}
        </select>
      </label>

      {kind ? (
        loading ? (
          <div
            data-testid={`${testIdPrefix}-loading`}
            style={{ color: "var(--wp-text-dim)" }}
          >
            Loading…
          </div>
        ) : options && options.length > 0 ? (
          <label style={{ display: "grid", gap: 2 }}>
            <span style={{ color: "var(--wp-text-dim)" }}>Pick one</span>
            <select
              data-testid={`${testIdPrefix}-id`}
              value={id}
              onChange={(e) => {
                const picked = options.find((o) => o.id === e.target.value);
                onChange({
                  kind,
                  id: e.target.value,
                  label: picked?.label || "",
                });
              }}
              style={{
                background: "var(--wp-dark)",
                border: "1px solid var(--wp-dark-border)",
                color: "var(--wp-text)",
                borderRadius: 4,
                padding: "3px 6px",
                fontSize: "0.75rem",
              }}
            >
              <option value="">— select —</option>
              {options.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <div
            data-testid={`${testIdPrefix}-manual`}
            style={{ display: "grid", gap: 4 }}
          >
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ color: "var(--wp-text-dim)" }}>
                {endpointAvailable === false
                  ? "ID (manual — list endpoint unavailable)"
                  : options && options.length === 0
                    ? "No items found. Enter ID manually:"
                    : "ID (manual)"}
              </span>
              <input
                data-testid={`${testIdPrefix}-manual-id`}
                type="text"
                value={manualId}
                onChange={(e) => setManualId(e.target.value)}
                onBlur={() => {
                  if (manualId)
                    onChange({
                      kind,
                      id: manualId,
                      label: manualLabel || manualId,
                    });
                }}
                style={{
                  background: "var(--wp-dark)",
                  border: "1px solid var(--wp-dark-border)",
                  color: "var(--wp-text)",
                  borderRadius: 4,
                  padding: "3px 6px",
                  fontSize: "0.75rem",
                }}
              />
            </label>
            <label style={{ display: "grid", gap: 2 }}>
              <span style={{ color: "var(--wp-text-dim)" }}>Label</span>
              <input
                data-testid={`${testIdPrefix}-manual-label`}
                type="text"
                value={manualLabel}
                onChange={(e) => setManualLabel(e.target.value)}
                onBlur={() => {
                  if (manualId)
                    onChange({
                      kind,
                      id: manualId,
                      label: manualLabel || manualId,
                    });
                }}
                style={{
                  background: "var(--wp-dark)",
                  border: "1px solid var(--wp-dark-border)",
                  color: "var(--wp-text)",
                  borderRadius: 4,
                  padding: "3px 6px",
                  fontSize: "0.75rem",
                }}
              />
            </label>
          </div>
        )
      ) : null}
    </div>
  );
}

/* Suppress unused-import lint for future use. */
void useMemo;

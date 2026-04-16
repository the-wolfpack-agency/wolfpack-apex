import { fetchWithRefresh } from "@/lib/client-auth";
"use client";

/**
 * NotebookPicker — drill-down notebook → section → create-page drawer.
 *
 * v1 — picks a notebook + section, then lets the user author a new page
 * with title + plain HTML textarea. onCreated is fired once the Graph
 * POST comes back so the parent can refresh its page list.
 *
 * TODO: swap the textarea for a rich editor (TipTap / Slate) once we pick
 * one. For now the textarea accepts raw HTML which createPage wraps in
 * the required <html><body> envelope inside the integration module.
 */

import { useCallback, useEffect, useState } from "react";

export interface NotebookPickerProps {
  open: boolean;
  onClose: () => void;
  onCreated?: (page: { id: string; webUrl?: string }) => void;
  getAuthHeader?: () => string | null;
}

interface Notebook {
  id: string;
  displayName: string;
}

interface Section {
  id: string;
  displayName: string;
}

function defaultAuth(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const t = window.localStorage.getItem("instinct_token");
    return t ? `Bearer ${t}` : null;
  } catch {
    return null;
  }
}

export default function NotebookPicker({
  open,
  onClose,
  onCreated,
  getAuthHeader,
}: NotebookPickerProps) {
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [sections, setSections] = useState<Section[]>([]);
  const [selectedNotebook, setSelectedNotebook] = useState<string>("");
  const [selectedSection, setSelectedSection] = useState<string>("");
  const [title, setTitle] = useState("");
  const [html, setHtml] = useState("");
  const [status, setStatus] = useState<"idle" | "loading" | "creating" | "error">("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  const auth = useCallback(() => (getAuthHeader ?? defaultAuth)(), [getAuthHeader]);

  useEffect(() => {
    if (!open) return;
    setStatus("loading");
    setErrorMsg(null);
    const a = auth();
    fetchWithRefresh("/api/onenote/notebooks", { headers: a ? { authorization: a } : undefined })
      .then(async (res) => {
        if (!res.ok) throw new Error(`notebooks ${res.status}`);
        const data = (await res.json()) as { notebooks?: Notebook[] };
        setNotebooks(data.notebooks ?? []);
        setStatus("idle");
      })
      .catch((err: Error) => {
        setErrorMsg(err.message);
        setStatus("error");
      });
  }, [open, auth]);

  useEffect(() => {
    if (!selectedNotebook) {
      setSections([]);
      return;
    }
    const a = auth();
    fetchWithRefresh(`/api/onenote/sections?notebookId=${encodeURIComponent(selectedNotebook)}`, {
      headers: a ? { authorization: a } : undefined,
    })
      .then(async (res) => {
        if (!res.ok) throw new Error(`sections ${res.status}`);
        const data = (await res.json()) as { sections?: Section[] };
        setSections(data.sections ?? []);
      })
      .catch((err: Error) => {
        setErrorMsg(err.message);
      });
  }, [selectedNotebook, auth]);

  async function handleCreate() {
    if (!selectedSection || !title.trim()) return;
    setStatus("creating");
    setErrorMsg(null);
    try {
      const a = auth();
      const res = await fetchWithRefresh("/api/onenote/pages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(a ? { authorization: a } : {}),
        },
        body: JSON.stringify({
          sectionId: selectedSection,
          title: title.trim(),
          html,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data?.error ?? `create failed ${res.status}`);
      }
      const data = (await res.json()) as { page?: { id: string; webUrl?: string } };
      if (data.page && onCreated) onCreated(data.page);
      setTitle("");
      setHtml("");
      setStatus("idle");
      onClose();
    } catch (err) {
      setErrorMsg((err as Error).message);
      setStatus("error");
    }
  }

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-label="Create OneNote page"
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(15, 23, 42, 0.5)",
        display: "flex",
        alignItems: "flex-end",
        justifyContent: "center",
        zIndex: 50,
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "white",
          width: "min(640px, 100%)",
          padding: 24,
          borderRadius: "16px 16px 0 0",
          boxShadow: "0 -8px 32px rgba(0,0,0,0.2)",
        }}
      >
        <h2 style={{ fontSize: 20, fontWeight: 600, margin: 0, marginBottom: 16 }}>
          Create OneNote page
        </h2>

        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: "#6b7280" }}>Notebook</span>
          <select
            value={selectedNotebook}
            onChange={(e) => {
              setSelectedNotebook(e.target.value);
              setSelectedSection("");
            }}
            aria-label="Notebook"
            style={{
              display: "block",
              width: "100%",
              padding: 8,
              marginTop: 4,
              borderRadius: 8,
              border: "1px solid #d1d5db",
            }}
          >
            <option value="">Select notebook…</option>
            {notebooks.map((n) => (
              <option key={n.id} value={n.id}>
                {n.displayName}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: "#6b7280" }}>Section</span>
          <select
            value={selectedSection}
            onChange={(e) => setSelectedSection(e.target.value)}
            aria-label="Section"
            disabled={!selectedNotebook}
            style={{
              display: "block",
              width: "100%",
              padding: 8,
              marginTop: 4,
              borderRadius: 8,
              border: "1px solid #d1d5db",
            }}
          >
            <option value="">Select section…</option>
            {sections.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </label>

        <label style={{ display: "block", marginBottom: 12 }}>
          <span style={{ fontSize: 12, color: "#6b7280" }}>Title</span>
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            aria-label="Title"
            style={{
              display: "block",
              width: "100%",
              padding: 8,
              marginTop: 4,
              borderRadius: 8,
              border: "1px solid #d1d5db",
            }}
          />
        </label>

        <label style={{ display: "block", marginBottom: 16 }}>
          <span style={{ fontSize: 12, color: "#6b7280" }}>Body (HTML — rich editor coming soon)</span>
          <textarea
            value={html}
            onChange={(e) => setHtml(e.target.value)}
            aria-label="Body"
            rows={6}
            style={{
              display: "block",
              width: "100%",
              padding: 8,
              marginTop: 4,
              borderRadius: 8,
              border: "1px solid #d1d5db",
              fontFamily: "monospace",
              fontSize: 13,
            }}
          />
        </label>

        {errorMsg && (
          <p style={{ color: "#b91c1c", fontSize: 13, marginBottom: 12 }} role="alert">
            {errorMsg}
          </p>
        )}

        <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
          <button
            type="button"
            onClick={onClose}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "1px solid #d1d5db",
              background: "white",
              cursor: "pointer",
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleCreate}
            disabled={!selectedSection || !title.trim() || status === "creating"}
            style={{
              padding: "8px 16px",
              borderRadius: 8,
              border: "none",
              background: "#4338ca",
              color: "white",
              cursor: !selectedSection || !title.trim() ? "not-allowed" : "pointer",
              opacity: !selectedSection || !title.trim() ? 0.6 : 1,
            }}
          >
            {status === "creating" ? "Creating…" : "Create page"}
          </button>
        </div>
      </div>
    </div>
  );
}

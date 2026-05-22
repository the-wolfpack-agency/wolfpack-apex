"use client";

/**
 * RecognizeView — client surface for /documents/recognize.
 *
 * State machine:
 *   idle        — show the hero drop zone
 *   uploading   — file selected, posting to API
 *   recognized  — show classification card + extracted fields
 *   error       — show the error + retry
 *
 * All authed fetches go through fetchWithRefresh (CLAUDE.md). The
 * page-wide drag listener mirrors the invoices UX so dragging a file
 * anywhere on the page lights up the drop zone. Mobile + desktop
 * responsive — the layout collapses to single column under md:.
 */

import { useCallback, useEffect, useState } from "react";
import {
  fetchWithRefresh,
  getInstinctToken,
} from "@/lib/client-auth";
import {
  type DocumentType,
  type RecognizedDocument,
  MAX_DOCUMENT_BYTES,
  SUPPORTED_MIMES,
} from "@/lib/document-recognition/types";
import { ClassificationCard } from "./components/ClassificationCard";
import { ExtractedFieldsTable } from "./components/ExtractedFieldsTable";

/** Accept attribute string mirroring SUPPORTED_MIMES. */
const ACCEPT_ATTR =
  "image/png,image/jpeg,image/webp,application/pdf,.pdf,.jpg,.jpeg,.png,.webp";

type ViewState =
  | { kind: "idle" }
  | { kind: "uploading"; filename: string }
  | { kind: "recognized"; doc: RecognizedDocument }
  | { kind: "error"; message: string };

function rerouteToLogin() {
  if (typeof window === "undefined") return;
  window.location.href = "/login?next=/documents/recognize";
}

function isSupportedMime(mime: string): boolean {
  /* SUPPORTED_MIMES is a ReadonlySet — `.has` is the contract check. */
  return SUPPORTED_MIMES.has(mime);
}

export function RecognizeView() {
  const [authChecked, setAuthChecked] = useState(false);
  const [view, setView] = useState<ViewState>({ kind: "idle" });
  const [isDragOver, setIsDragOver] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);

  /* Auth gate. Mirror the qr/page.tsx convention — no token = redirect
     to /login?next=<this>. Never render an empty 200 body. */
  useEffect(() => {
    if (!getInstinctToken()) {
      rerouteToLogin();
      return;
    }
    setAuthChecked(true);
  }, []);

  /* Window-level drag detection so dropping ANYWHERE on the page
     lights up the hero zone (same UX as the invoices page). Counter
     skipped on purpose — the hero zone owns the final drop event. */
  useEffect(() => {
    if (!authChecked) return;
    const onDragOver = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes("Files")) {
        e.preventDefault();
        setIsDragOver(true);
      }
    };
    const onDragLeave = (e: DragEvent) => {
      if (e.clientX === 0 && e.clientY === 0) setIsDragOver(false);
    };
    const onDrop = () => setIsDragOver(false);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [authChecked]);

  const handleFile = useCallback(async (file: File) => {
    setSizeError(null);

    if (file.size > MAX_DOCUMENT_BYTES) {
      const mb = (file.size / (1024 * 1024)).toFixed(1);
      setSizeError(
        `File too large (${mb} MB). Maximum is ${(MAX_DOCUMENT_BYTES / (1024 * 1024)).toFixed(1)} MB.`,
      );
      /* IMPORTANT: never call the API once we've decided it's oversize.
         Tests assert exactly this. */
      return;
    }

    if (file.type && !isSupportedMime(file.type)) {
      setSizeError(
        `Unsupported file type: ${file.type}. Use PNG, JPEG, WebP, or PDF.`,
      );
      return;
    }

    setView({ kind: "uploading", filename: file.name });
    try {
      const form = new FormData();
      form.append("file", file, file.name);
      const res = await fetchWithRefresh("/api/documents/recognize", {
        method: "POST",
        body: form,
      });

      if (!res.ok) {
        const body = (await res
          .json()
          .catch(() => ({}))) as { error?: string; message?: string };
        const detail = body.error ?? body.message ?? `HTTP ${res.status}`;
        setView({ kind: "error", message: detail });
        return;
      }

      const doc = (await res.json()) as RecognizedDocument;
      setView({ kind: "recognized", doc });
    } catch (err) {
      setView({ kind: "error", message: (err as Error).message });
    }
  }, []);

  const handleCorrected = useCallback(
    async (correctedType: DocumentType) => {
      if (view.kind !== "recognized") return;
      const prev = view.doc;
      /* Optimistic update — we trust the server confirms the patch.
         If it doesn't, we surface the error AND roll the view back. */
      const optimistic: RecognizedDocument = {
        ...prev,
        classification: { ...prev.classification, type: correctedType },
      };
      setView({ kind: "recognized", doc: optimistic });
      try {
        const res = await fetchWithRefresh(
          `/api/documents/recognize/${encodeURIComponent(prev.id)}`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ user_corrected_type: correctedType }),
          },
        );
        if (!res.ok) {
          /* Roll back. The card will re-render with prev.classification. */
          setView({ kind: "recognized", doc: prev });
          const body = (await res.json().catch(() => ({}))) as { error?: string };
          setSizeError(
            body.error ??
              `Could not save correction (HTTP ${res.status}). The change was reverted.`,
          );
        }
      } catch (err) {
        setView({ kind: "recognized", doc: prev });
        setSizeError(
          `Could not save correction: ${(err as Error).message}. The change was reverted.`,
        );
      }
    },
    [view],
  );

  const scanAnother = useCallback(() => {
    setView({ kind: "idle" });
    setSizeError(null);
    setIsDragOver(false);
  }, []);

  if (!authChecked) {
    /* Pre-auth-check pass renders nothing. The redirect fires in the
       useEffect; we never expose an empty authenticated page. */
    return null;
  }

  const uploading = view.kind === "uploading";

  /* ──────────────────────────────────────────────────────────────── */
  /* Recognized state                                                  */
  /* ──────────────────────────────────────────────────────────────── */
  if (view.kind === "recognized") {
    const doc = view.doc;
    if (doc.piiBlocked) {
      return (
        <div className="space-y-4" data-testid="recognize-view">
          <div
            data-testid="recognize-pii-blocked"
            className="rounded-lg px-4 py-4 text-sm"
            style={{
              background: "rgba(248,113,113,0.10)",
              border: "1px solid #f87171",
              color: "#f87171",
            }}
          >
            <strong className="block mb-1">
              Document blocked for sensitive content
            </strong>
            Instinct detected sensitive personal information (e.g. SSN
            or government ID number) on this file. We did not send the
            file to any vendor extractor, and nothing was stored
            beyond the audit log entry.
          </div>
          <button
            type="button"
            onClick={scanAnother}
            data-testid="recognize-scan-another"
            className="px-3 py-1.5 text-xs rounded font-medium"
            style={{
              background: "var(--wp-gold, #eab308)",
              color: "var(--wp-dark, #111)",
              border: "none",
              cursor: "pointer",
            }}
          >
            Scan another
          </button>
        </div>
      );
    }

    return (
      <div
        className="grid grid-cols-1 md:grid-cols-2 gap-4"
        data-testid="recognize-view"
      >
        <ClassificationCard
          classification={doc.classification}
          recognitionId={doc.id}
          onCorrected={(t) => void handleCorrected(t)}
        />
        <ExtractedFieldsTable fields={doc.extraction?.fields ?? []} />
        <div className="md:col-span-2 flex items-center justify-between flex-wrap gap-2">
          <div
            className="text-xs"
            style={{ color: "var(--wp-text-muted, #6b7280)" }}
            data-testid="recognize-source-meta"
          >
            {doc.sourceFile.filename} · {doc.sourceFile.mime} ·{" "}
            {(doc.sourceFile.bytes / 1024).toFixed(1)} KB
          </div>
          <button
            type="button"
            onClick={scanAnother}
            data-testid="recognize-scan-another"
            className="px-3 py-1.5 text-xs rounded font-medium"
            style={{
              background: "var(--wp-gold, #eab308)",
              color: "var(--wp-dark, #111)",
              border: "none",
              cursor: "pointer",
            }}
          >
            Scan another
          </button>
        </div>
        {sizeError && (
          <div
            data-testid="recognize-inline-error"
            className="md:col-span-2 text-xs rounded px-3 py-2"
            style={{
              background: "rgba(248,113,113,0.08)",
              border: "1px solid #f87171",
              color: "#f87171",
            }}
          >
            {sizeError}
          </div>
        )}
      </div>
    );
  }

  /* ──────────────────────────────────────────────────────────────── */
  /* Error state                                                       */
  /* ──────────────────────────────────────────────────────────────── */
  if (view.kind === "error") {
    return (
      <div className="space-y-3" data-testid="recognize-view">
        <div
          data-testid="recognize-error"
          className="rounded-lg px-4 py-3 text-sm"
          style={{
            background: "rgba(248,113,113,0.08)",
            border: "1px solid #f87171",
            color: "#f87171",
          }}
        >
          <strong className="block mb-1">Recognition failed</strong>
          {view.message}
        </div>
        <button
          type="button"
          onClick={scanAnother}
          data-testid="recognize-retry"
          className="px-3 py-1.5 text-xs rounded font-medium"
          style={{
            background: "var(--wp-gold, #eab308)",
            color: "var(--wp-dark, #111)",
            border: "none",
            cursor: "pointer",
          }}
        >
          Try another file
        </button>
      </div>
    );
  }

  /* ──────────────────────────────────────────────────────────────── */
  /* Idle / uploading state — hero drop zone                           */
  /* ──────────────────────────────────────────────────────────────── */
  return (
    <div className="space-y-3" data-testid="recognize-view">
      <label
        data-testid="recognize-drop-zone"
        htmlFor="recognize-upload-input-el"
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragEnter={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={(e) => {
          if (e.currentTarget === e.target) setIsDragOver(false);
        }}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          const f = e.dataTransfer?.files?.[0];
          if (f && !uploading) void handleFile(f);
        }}
        className="block rounded-lg transition-all"
        style={{
          background: isDragOver
            ? "rgba(234,179,8,0.10)"
            : uploading
              ? "var(--wp-dark-surface2, #1a1a1a)"
              : "var(--wp-dark-surface, #151515)",
          border: `2px dashed ${
            isDragOver
              ? "var(--wp-gold, #eab308)"
              : uploading
                ? "var(--wp-text-muted, #6b7280)"
                : "var(--wp-dark-border, #333)"
          }`,
          cursor: uploading ? "wait" : "pointer",
          boxShadow: isDragOver ? "0 0 0 4px rgba(234,179,8,0.15)" : "none",
        }}
      >
        <input
          id="recognize-upload-input-el"
          type="file"
          accept={ACCEPT_ATTR}
          data-testid="recognize-upload-input"
          style={{ display: "none" }}
          disabled={uploading}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void handleFile(f);
            e.target.value = "";
          }}
        />
        <div className="flex flex-col items-center justify-center gap-2 px-6 py-10 text-center">
          {uploading ? (
            <>
              <svg
                className="animate-spin"
                width="36"
                height="36"
                viewBox="0 0 24 24"
                fill="none"
                style={{ color: "var(--wp-gold, #eab308)" }}
                aria-hidden
                data-testid="recognize-spinner"
              >
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  opacity="0.25"
                />
                <path
                  d="M12 2 a10 10 0 0 1 10 10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeLinecap="round"
                />
              </svg>
              <div
                data-testid="recognize-drop-headline"
                className="text-base font-semibold"
                style={{ color: "var(--wp-text, #eee)" }}
              >
                Recognizing document…
              </div>
              <div
                data-testid="recognize-drop-microcopy"
                className="text-xs max-w-md"
                style={{ color: "var(--wp-text-dim, #aaa)" }}
              >
                Classifying, then routing to the right extractor.
              </div>
            </>
          ) : (
            <>
              <svg
                width="44"
                height="44"
                viewBox="0 0 24 24"
                fill="none"
                style={{
                  color: isDragOver
                    ? "var(--wp-gold, #eab308)"
                    : "var(--wp-text-dim, #aaa)",
                }}
                aria-hidden
              >
                <path
                  d="M7 18a5 5 0 0 1-1-9.9V8a6 6 0 0 1 11.7-1.5A4.5 4.5 0 0 1 21 11.5c0 2.5-2 4.5-4.5 4.5H17"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
                <path
                  d="M12 12v8m0-8-3 3m3-3 3 3"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <div
                data-testid="recognize-drop-headline"
                className="text-lg font-semibold"
                style={{ color: "var(--wp-text, #eee)" }}
              >
                {isDragOver ? "Drop to recognize" : "Upload a document"}
              </div>
              <div
                data-testid="recognize-drop-microcopy"
                className="text-xs max-w-md"
                style={{ color: "var(--wp-text-dim, #aaa)" }}
              >
                Drop a PDF or photo here, or{" "}
                <span
                  style={{
                    color: "var(--wp-gold, #eab308)",
                    textDecoration: "underline",
                  }}
                >
                  click to browse
                </span>
                . Receipts, invoices, W-2s, 1099s, and IDs are supported.
              </div>
              <div
                className="text-[11px] mt-1"
                style={{ color: "var(--wp-text-muted, #6b7280)" }}
              >
                PDF · JPG · PNG · WebP · up to{" "}
                {(MAX_DOCUMENT_BYTES / (1024 * 1024)).toFixed(1)} MB
              </div>
            </>
          )}
        </div>
      </label>

      {sizeError && (
        <div
          data-testid="recognize-size-error"
          className="text-xs rounded px-3 py-2"
          style={{
            background: "rgba(248,113,113,0.08)",
            border: "1px solid #f87171",
            color: "#f87171",
          }}
        >
          {sizeError}
        </div>
      )}
    </div>
  );
}

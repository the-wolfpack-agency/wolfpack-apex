/**
 * UploadToBrainWidget — drag/drop panel that adds files directly to
 * the user's Brain.
 *
 * Each dropped file is POSTed to /api/brain/upload (multipart). That
 * endpoint runs the server-side `runUploadFilter` gate BEFORE handing
 * off to the existing ingest() pipeline, so bad uploads (secrets,
 * PII, oversized, duplicate, repetitive, disallowed MIME) get rejected
 * with a stable `reasons` array we render as chips.
 *
 * Accessibility: the drop zone is a `role="button"` with keyboard
 * fallback (Enter / Space → opens the file picker) so the widget
 * works without a pointer device.
 *
 * The widget is intentionally local-state — file rows only live for
 * the lifetime of this render. The permanent record is in the Brain
 * (and the rejection analytics trail) the moment the response lands.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import type { UploadToBrainWidgetSpec } from "@/lib/assistant/widgets/types";

type RowStatus = "pending" | "uploading" | "accepted" | "rejected";

interface FileRow {
  id: string;
  name: string;
  size: number;
  mime: string;
  status: RowStatus;
  reasons?: string[];
  warnings?: string[];
  documentId?: string;
  duplicateOf?: string;
}

export interface UploadToBrainWidgetProps {
  spec: UploadToBrainWidgetSpec;
  workflowId?: string;
}

/**
 * MIME → preferred file extensions for the file-input `accept`
 * attribute. Browsers (notably macOS Safari + Finder) won't show
 * .md / .txt / .json / .html files in the picker unless the
 * extension itself is listed — the bare MIME types alone aren't
 * enough. Without this, users could only select .pdf and .csv from
 * the supported list, even though the server filter accepts every
 * MIME in UPLOAD_FILTER_ALLOWED_MIME_TYPES.
 */
const MIME_TO_EXTS: Record<string, string[]> = {
  "application/pdf": [".pdf"],
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": [".docx"],
  "application/json": [".json"],
  "text/plain": [".txt"],
  "text/markdown": [".md", ".markdown"],
  "text/html": [".html", ".htm"],
  "text/csv": [".csv"],
};

function buildAcceptAttr(mimeTypes: readonly string[]): string {
  const parts: string[] = [];
  for (const mime of mimeTypes) {
    parts.push(mime);
    const exts = MIME_TO_EXTS[mime];
    if (exts) parts.push(...exts);
  }
  return parts.join(",");
}

export function UploadToBrainWidget({ spec, workflowId }: UploadToBrainWidgetProps) {
  const [rows, setRows] = useState<FileRow[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [pasteTitle, setPasteTitle] = useState("");
  const [pasteText, setPasteText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  /* Stable analytics helper. Each call fires
   * assistant.widget_interaction tagged with the workflow_id so the
   * funnel (intent → tool → widget → file_dropped → file_accepted)
   * joins. Failures (no auth, transient network) swallow — analytics
   * is best-effort and must never crash the upload UX. */
  const track = useCallback(
    (action: string, value?: string) => {
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "assistant.widget_interaction",
          metadata: {
            widget_kind: "upload_to_brain",
            action,
            ...(value ? { value } : {}),
            ...(workflowId ? { workflow_id: workflowId } : {}),
          },
        }),
      }).catch(() => undefined);
    },
    [workflowId],
  );

  /* One-shot mount analytics — the widget being rendered tells the
   * learning loop the user is in upload mode, independent of whether
   * any file actually gets dropped. */
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.upload_widget_opened",
        metadata: {
          widget_kind: "upload_to_brain",
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.widget_rendered",
        metadata: {
          widget_kind: "upload_to_brain",
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [workflowId]);

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const fileArray = Array.from(files);
      if (fileArray.length === 0) return;

      const newRows: FileRow[] = fileArray.map((f) => ({
        id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        name: f.name,
        size: f.size,
        mime: f.type || "application/octet-stream",
        status: "pending",
      }));

      setRows((prev) => [...prev, ...newRows]);
      for (const row of newRows) track("file_dropped", row.mime);

      // POST each file sequentially so the rate limiter doesn't burst-
      // reject the second one. Each call is independent — one file's
      // rejection doesn't block the others.
      for (let i = 0; i < newRows.length; i++) {
        const file = fileArray[i];
        const row = newRows[i];
        setRows((prev) =>
          prev.map((r) => (r.id === row.id ? { ...r, status: "uploading" } : r)),
        );

        const form = new FormData();
        form.append("file", file, file.name);
        let res: Response | null = null;
        try {
          res = await fetchWithRefresh(spec.uploadUrl, {
            method: "POST",
            body: form,
          });
        } catch {
          setRows((prev) =>
            prev.map((r) =>
              r.id === row.id
                ? { ...r, status: "rejected", reasons: ["network_error"] }
                : r,
            ),
          );
          track("file_rejected", "network_error");
          continue;
        }

        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          /* not JSON */
        }
        const b = (body ?? {}) as {
          document_id?: string;
          duplicate_of?: string;
          reasons?: string[];
          warnings?: string[];
          error?: string;
        };

        if (res.ok) {
          setRows((prev) =>
            prev.map((r) =>
              r.id === row.id
                ? {
                    ...r,
                    status: "accepted",
                    documentId: b.document_id,
                    duplicateOf: b.duplicate_of,
                    warnings: b.warnings ?? [],
                  }
                : r,
            ),
          );
          track("file_accepted", row.mime);
        } else {
          const reasons =
            Array.isArray(b.reasons) && b.reasons.length > 0
              ? b.reasons
              : [b.error ?? `http_${res.status}`];
          setRows((prev) =>
            prev.map((r) =>
              r.id === row.id ? { ...r, status: "rejected", reasons } : r,
            ),
          );
          track("file_rejected", reasons[0]);
        }
      }
    },
    [spec.uploadUrl, track],
  );

  const onDragOver = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (!isDragging) setIsDragging(true);
  };
  const onDragLeave = () => setIsDragging(false);
  const onDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    if (e.dataTransfer?.files?.length) {
      void handleFiles(e.dataTransfer.files);
    }
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      inputRef.current?.click();
    }
  };

  const acceptedCount = rows.filter((r) => r.status === "accepted").length;
  const rejectedCount = rows.filter((r) => r.status === "rejected").length;
  const pendingCount = rows.filter(
    (r) => r.status === "pending" || r.status === "uploading",
  ).length;

  return (
    <div
      data-testid="upload-to-brain-widget"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div
        className="flex items-center justify-between mb-2"
        style={{ color: "var(--wp-text-dim, #aaa)" }}
      >
        <div>
          <div className="text-sm font-semibold">Upload to Brain</div>
          <div className="text-xs" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
            {acceptedCount} accepted, {rejectedCount} rejected, {pendingCount} pending
          </div>
        </div>
      </div>

      <div
        data-testid="upload-drop-zone"
        role="button"
        tabIndex={0}
        aria-label="Drop files to add them to your Brain"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onKeyDown={onKeyDown}
        onClick={() => inputRef.current?.click()}
        className="rounded p-4 text-center text-xs cursor-pointer"
        style={{
          border: `1px dashed ${
            isDragging ? "var(--wp-gold, #eab308)" : "var(--wp-text-muted, #6b7280)"
          }`,
          background: isDragging ? "rgba(234, 179, 8, 0.05)" : "transparent",
          color: "var(--wp-text-dim, #aaa)",
        }}
      >
        <div>Drop files here, or click to browse.</div>
        <div className="text-[10px] mt-1" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
          Up to {(spec.maxFileSize / (1024 * 1024)).toFixed(0)} MB · PDF, DOCX, MD, TXT, HTML, CSV, JSON.
          Filtered for secrets, PII, and duplicates before ingest.
        </div>
        <input
          ref={inputRef}
          type="file"
          multiple
          accept={buildAcceptAttr(spec.allowedMimeTypes)}
          onChange={(e) => {
            if (e.target.files?.length) void handleFiles(e.target.files);
            e.target.value = "";
          }}
          style={{ display: "none" }}
          data-testid="upload-file-input"
        />
      </div>

      {/* Paste-text path — for users on iPad / iPhone who can copy a
          chunk of text (Apple Notes meeting minutes, a Slack thread,
          a Notion block) and want it in the Brain without exporting
          to a .txt file first. Stored as `<title>.md` so it goes
          through the same dedup / secret / PII filter as a real
          markdown drop. */}
      <div className="mt-2 flex items-center justify-between text-xs">
        <button
          type="button"
          data-testid="upload-paste-toggle"
          onClick={(e) => {
            e.stopPropagation();
            setPasteOpen((v) => !v);
          }}
          className="underline"
          style={{ color: "var(--wp-text-dim, #aaa)", background: "transparent", border: "none", cursor: "pointer" }}
        >
          {pasteOpen ? "Hide paste" : "Or paste text (Apple Notes, Slack, anything)"}
        </button>
      </div>

      {pasteOpen && (
        <div
          className="mt-2 rounded p-2 space-y-2"
          style={{
            background: "var(--wp-dark, #111)",
            border: "1px solid var(--wp-dark-border, #333)",
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <input
            type="text"
            value={pasteTitle}
            onChange={(e) => setPasteTitle(e.target.value)}
            placeholder="Title (optional — defaults to date)"
            data-testid="upload-paste-title"
            className="w-full px-2 py-1.5 text-xs rounded"
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              border: "1px solid var(--wp-dark-border, #333)",
              color: "var(--wp-text, #eee)",
              fontSize: "16px",
            }}
          />
          <textarea
            value={pasteText}
            onChange={(e) => setPasteText(e.target.value)}
            placeholder="Paste meeting notes, an article, a Slack thread, anything..."
            data-testid="upload-paste-text"
            rows={6}
            className="w-full px-2 py-1.5 text-xs rounded resize-y"
            style={{
              background: "var(--wp-dark-surface2, #1a1a1a)",
              border: "1px solid var(--wp-dark-border, #333)",
              color: "var(--wp-text, #eee)",
              fontSize: "16px",
              minHeight: "120px",
            }}
          />
          <div className="flex items-center justify-between text-[10px]" style={{ color: "var(--wp-text-muted, #6b7280)" }}>
            <span>{pasteText.length.toLocaleString()} chars</span>
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => {
                  setPasteText("");
                  setPasteTitle("");
                  setPasteOpen(false);
                }}
                className="px-2 py-1 rounded text-xs"
                style={{ background: "var(--wp-dark-surface2, #1a1a1a)", color: "var(--wp-text-dim, #aaa)", border: "1px solid var(--wp-dark-border, #333)" }}
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="upload-paste-submit"
                disabled={!pasteText.trim()}
                onClick={() => {
                  const body = pasteText.trim();
                  if (!body) return;
                  const rawTitle = pasteTitle.trim() || `Note - ${new Date().toLocaleString()}`;
                  const safeTitle = rawTitle.replace(/[^\w\-. ]+/g, " ").slice(0, 80).trim() || "Note";
                  const filename = `${safeTitle}.md`;
                  const blob = new Blob([body], { type: "text/markdown" });
                  const file = new File([blob], filename, { type: "text/markdown" });
                  void handleFiles([file]);
                  setPasteText("");
                  setPasteTitle("");
                  setPasteOpen(false);
                }}
                className="px-3 py-1 rounded text-xs font-medium"
                style={{
                  background: pasteText.trim() ? "var(--wp-gold, #eab308)" : "var(--wp-dark-surface2, #1a1a1a)",
                  color: pasteText.trim() ? "var(--wp-dark, #111)" : "var(--wp-text-muted, #6b7280)",
                  cursor: pasteText.trim() ? "pointer" : "not-allowed",
                }}
              >
                Add to Brain
              </button>
            </div>
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <ul className="space-y-1 mt-2">
          {rows.map((r) => (
            <li
              key={r.id}
              data-testid={`upload-row-${r.id}`}
              className="text-xs rounded px-2 py-1.5 flex items-start gap-2"
              style={{
                background: "var(--wp-dark, #111)",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            >
              <StatusBadge status={r.status} />
              <div className="flex-1 min-w-0">
                <div className="truncate" style={{ color: "var(--wp-text, #eee)" }}>
                  {r.name}
                </div>
                <div
                  className="flex items-center flex-wrap gap-x-2 gap-y-0.5 mt-0.5"
                  style={{ color: "var(--wp-text-muted, #6b7280)" }}
                >
                  <span>{formatBytes(r.size)}</span>
                  {r.mime && <span>{r.mime}</span>}
                  {r.status === "accepted" && (
                    <span
                      data-testid={`upload-row-accepted-${r.id}`}
                      style={{ color: "#4ade80" }}
                    >
                      {r.duplicateOf ? "Already in Brain (dedup)" : "Added to Brain"}
                    </span>
                  )}
                  {r.status === "rejected" && r.reasons && (
                    <span
                      data-testid={`upload-row-rejected-${r.id}`}
                      className="flex flex-wrap gap-1"
                    >
                      {r.reasons.map((reason) => (
                        <span
                          key={reason}
                          className="rounded px-1.5 py-0.5"
                          style={{
                            background: "rgba(248, 113, 113, 0.1)",
                            color: "#f87171",
                            border: "1px solid #f87171",
                          }}
                        >
                          {reason}
                        </span>
                      ))}
                    </span>
                  )}
                  {r.warnings && r.warnings.length > 0 && (
                    <span className="flex flex-wrap gap-1">
                      {r.warnings.map((w) => (
                        <span
                          key={w}
                          className="rounded px-1.5 py-0.5"
                          style={{
                            background: "rgba(234, 179, 8, 0.1)",
                            color: "var(--wp-gold, #eab308)",
                            border: "1px solid var(--wp-gold, #eab308)",
                          }}
                        >
                          warning: {w}
                        </span>
                      ))}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function StatusBadge({ status }: { status: RowStatus }) {
  const map: Record<RowStatus, { label: string; color: string }> = {
    pending: { label: "…", color: "var(--wp-text-muted, #6b7280)" },
    uploading: { label: "…", color: "var(--wp-gold, #eab308)" },
    accepted: { label: "✓", color: "#4ade80" },
    rejected: { label: "✗", color: "#f87171" },
  };
  const { label, color } = map[status];
  return (
    <span
      aria-label={status}
      className="flex-none w-4 h-4 rounded-full text-[10px] flex items-center justify-center mt-0.5"
      style={{ background: "transparent", color, border: `1px solid ${color}` }}
    >
      {label}
    </span>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

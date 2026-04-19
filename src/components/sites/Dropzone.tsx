"use client";

/**
 * Shared Sites dropzone.
 *
 * Hoisted out of `/sites/[id]/page.tsx` so `/sites/new` and any future
 * Sites surface can reuse the same drop-target with identical styling.
 *
 * Backwards compatible with the original inline implementation:
 *
 *   <Dropzone
 *     label="Drop HTML…"
 *     accept=".html,.htm,.txt,.md"
 *     onFile={handleParseFile}
 *     compact
 *   />
 *
 * NEW: pass `acceptImages` to widen the underlying <input accept> and the
 * dragged-file filter to also include image + PDF MIME types. The caller
 * keeps sending the same `accept` string (still used for the existing
 * text formats); this flag simply unions in the image formats supported
 * by POST /api/sites/parse-brief.
 *
 * The image MIME set mirrors exactly what the server accepts today:
 *   image/png, image/jpeg, image/jpg, image/webp, application/pdf
 *
 * UX:
 *   - Gold border while a file is hovering.
 *   - Click opens the native file picker.
 *   - `data-testid="wireframe-dropzone"` when `acceptImages` is on so
 *     Playwright can target the image-aware dropzone unambiguously.
 */

import { forwardRef, useState } from "react";

export const WIREFRAME_IMAGE_MIMES = [
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
] as const;

// Extensions for the native file-picker <input accept> attribute. The
// browser matches either MIME or extension so we list both — PDFs in
// particular arrive as application/pdf OR application/x-pdf depending on
// OS, and some older browsers only honour extensions.
const WIREFRAME_IMAGE_EXTS = ".png,.jpg,.jpeg,.webp,.pdf";

export interface DropzoneProps {
  /** Visible copy inside the drop target. */
  label: string;
  /**
   * File-picker accept string. Combined with image formats when
   * `acceptImages` is true.
   */
  accept: string;
  /** Called once with the first dropped/selected file. */
  onFile: (file: File) => void;
  /**
   * Called when one-or-more files are dropped/selected while `multiple`
   * is on. Preferred when the caller wants the full list. `onFile` is
   * still called with file[0] for back-compat with single-file callers.
   */
  onFiles?: (files: File[]) => void;
  /**
   * Accept multiple files at once. When true the native input gets
   * `multiple` + the drop handler reads every file from dataTransfer.
   */
  multiple?: boolean;
  /** Tighter padding — used when the dropzone sits above a form. */
  compact?: boolean;
  /**
   * Widen the accept list to include wireframe image formats
   * (png/jpg/webp/pdf). Defaults to `false` for backwards compatibility.
   */
  acceptImages?: boolean;
  /**
   * Disable the dropzone — while a parse/upload is in flight. Visually
   * dims the target + blocks click + dragover.
   */
  disabled?: boolean;
  /**
   * Override the default `data-testid`. When `acceptImages` is on the
   * default becomes `wireframe-dropzone` so Playwright can find it.
   */
  testId?: string;
}

const Dropzone = forwardRef<HTMLDivElement, DropzoneProps>(function Dropzone(
  { label, accept, onFile, onFiles, multiple, compact, acceptImages, disabled, testId },
  ref,
) {
  const [over, setOver] = useState(false);

  // Union the caller's `accept` with the image exts when enabled. De-dup
  // so a caller that already lists `.png` doesn't end up with duplicates.
  const fullAccept = acceptImages
    ? dedupeAcceptList(`${accept},${WIREFRAME_IMAGE_EXTS}`)
    : accept;

  const effectiveTestId = testId ?? (acceptImages ? "wireframe-dropzone" : undefined);

  function dispatchFiles(files: FileList | File[] | null | undefined): void {
    if (!files || disabled) return;
    const list: File[] = Array.from(files).filter((f): f is File => !!f);
    if (list.length === 0) return;
    if (multiple && onFiles) {
      onFiles(list);
      return;
    }
    onFile(list[0]);
  }

  return (
    <div
      ref={ref}
      data-testid={effectiveTestId}
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-disabled={disabled || undefined}
      aria-label={label}
      onDragOver={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        if (disabled) return;
        e.preventDefault();
        setOver(false);
        dispatchFiles(e.dataTransfer.files);
      }}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          openPicker(fullAccept, !!multiple, (files) => dispatchFiles(files));
        }
      }}
      onClick={() => {
        if (disabled) return;
        openPicker(fullAccept, !!multiple, (files) => dispatchFiles(files));
      }}
      style={{
        padding: compact ? "0.85rem 1rem" : "1.25rem",
        border: `2px dashed ${over ? "var(--wp-gold)" : "var(--wp-border)"}`,
        borderRadius: "8px",
        textAlign: "center",
        background: over ? "rgba(255, 215, 0, 0.05)" : "transparent",
        transition: "all 0.15s ease",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.6 : 1,
      }}
    >
      <span style={{ color: "var(--wp-text-dim)", fontSize: "0.85rem" }}>{label}</span>
    </div>
  );
});

function openPicker(
  accept: string,
  multiple: boolean,
  onPick: (files: FileList | null) => void,
): void {
  if (typeof document === "undefined") return;
  const input = document.createElement("input");
  input.type = "file";
  input.accept = accept;
  if (multiple) input.multiple = true;
  input.onchange = () => onPick(input.files);
  input.click();
}

function dedupeAcceptList(combined: string): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of combined.split(",")) {
    const token = raw.trim();
    if (!token) continue;
    const key = token.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(token);
  }
  return out.join(",");
}

export default Dropzone;

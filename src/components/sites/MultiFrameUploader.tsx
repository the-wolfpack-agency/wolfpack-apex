"use client";

/**
 * MultiFrameUploader — wireframe drop/picker that accepts one OR many
 * images (PNG/JPG/WEBP) or a multi-page PDF. Wraps the shared Dropzone
 * so a single-file drop behaves identically to the legacy uploader
 * while additional drops append extra frames in page order.
 *
 * UX:
 *   - Drag or click to add frames. Additional drops append (they do NOT
 *     replace).
 *   - Numbered thumbnails render below the drop target with a remove
 *     button per frame — page order is communicated with `1.`, `2.` …
 *     captions so the designer knows which frame is page 1 of the site.
 *   - Reorder is OUT for the first ship — if ordering is wrong the user
 *     can Remove + re-drop in the right sequence. Keeps ship size small;
 *     no drag-reorder dep, no custom DnD helpers.
 *   - Thumbnails use URL.createObjectURL so we never rasterise bytes
 *     client-side — zero cost, zero GPU, zero new deps.
 *   - Once the user clicks "Analyze frames" the component hands the
 *     ordered File[] up to the parent via onSubmit. Parent owns the
 *     multipart POST so we keep the analytics and auth logic in one
 *     place (new-site page / edit page).
 *
 * Analytics (all new event names, registered in src/lib/analytics.ts):
 *   - site.brief_upload_frames_added   — fired on every add/drop
 *   - site.brief_upload_frame_removed  — fired when a frame is removed
 *     pre-submit
 *
 * The parent is responsible for the request-level analytics
 * (site.brief_multi_frame_requested is emitted server-side).
 */

import { useEffect, useRef, useState } from "react";
import Dropzone from "@/components/sites/Dropzone";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

export interface MultiFrameUploaderProps {
  /** Hard cap — keep in lockstep with the API route (10 today). */
  maxFrames?: number;
  /** 10 MB total across every frame (same cap the API enforces). */
  maxTotalBytes?: number;
  /**
   * Called with the ordered frames when the user clicks "Analyze
   * frames". The parent is responsible for POSTing to
   * /api/sites/parse-brief.
   */
  onSubmit: (frames: File[]) => void;
  /** Disables the submit button + dropzone while a parse is in flight. */
  disabled?: boolean;
  /** Shown inside the dropzone — override for edit page vs. new page. */
  label?: string;
  /** Override Playwright testid; default matches single-file dropzone. */
  testId?: string;
}

const DEFAULT_MAX_FRAMES = 10;
const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

// Keep this list aligned with SUPPORTED_IMAGE_MIMES in brief-from-image.ts.
// Mismatches are surfaced inline so the user isn't confused by a "rejected
// on the server" message when the client already knew the format was off.
const CLIENT_ACCEPTS = new Set([
  "image/png",
  "image/jpeg",
  "image/jpg",
  "image/webp",
  "application/pdf",
]);

function postAnalytics(event: string, metadata: Record<string, unknown>): void {
  if (typeof window === "undefined") return;
  try {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event, metadata }),
    }).catch(() => {
      /* best-effort — UX must not block on analytics */
    });
  } catch {
    /* swallow */
  }
}

interface ThumbState {
  file: File;
  /** blob: URL minted via URL.createObjectURL; revoked on remove/unmount. */
  previewUrl: string | null;
  /** Stable key so React can keep thumbnails ordered across re-renders. */
  id: string;
}

function makeThumb(file: File): ThumbState {
  // PDFs have no inline thumbnail — we show a doc chip instead.
  const isImage = file.type.startsWith("image/");
  return {
    file,
    previewUrl: isImage ? URL.createObjectURL(file) : null,
    id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 8)}`,
  };
}

export default function MultiFrameUploader({
  maxFrames = DEFAULT_MAX_FRAMES,
  maxTotalBytes = DEFAULT_MAX_BYTES,
  onSubmit,
  disabled,
  label,
  testId,
}: MultiFrameUploaderProps) {
  const [thumbs, setThumbs] = useState<ThumbState[]>([]);
  const [error, setError] = useState<string | null>(null);
  // Track the latest thumbnail state outside the render cycle so the
  // unmount cleanup effect can revoke every blob URL, and so add/remove
  // handlers can read the up-to-date list without depending on closures.
  const thumbsRef = useRef(thumbs);
  useEffect(() => {
    thumbsRef.current = thumbs;
  }, [thumbs]);

  useEffect(() => {
    // Revoke blob URLs on unmount so the page doesn't leak memory.
    return () => {
      for (const t of thumbsRef.current) {
        if (t.previewUrl) URL.revokeObjectURL(t.previewUrl);
      }
    };
  }, []);

  function validateAndAdd(incoming: File[]): void {
    setError(null);
    if (incoming.length === 0) return;

    // Reject unknown MIMEs up-front — the API will reject them anyway
    // but surfacing here saves a round-trip + gives the user a direct
    // message.
    const bad = incoming.find((f) => !CLIENT_ACCEPTS.has(f.type.toLowerCase()));
    if (bad) {
      setError(
        `"${bad.name}" isn't a supported format. Drop PNG, JPG, WEBP, or PDF files.`,
      );
      return;
    }

    // Use the functional updater so we see the latest list even during
    // rapid back-to-back drops. We compute projected caps inside the
    // updater and bail out with a setError path if exceeded.
    setThumbs((prev) => {
      const projectedCount = prev.length + incoming.length;
      if (projectedCount > maxFrames) {
        setError(
          `Too many frames — max ${maxFrames} per upload. You have ${prev.length}; tried to add ${incoming.length}.`,
        );
        return prev;
      }
      let projectedBytes = prev.reduce((n, t) => n + t.file.size, 0);
      for (const f of incoming) projectedBytes += f.size;
      if (projectedBytes > maxTotalBytes) {
        const mb = (maxTotalBytes / (1024 * 1024)).toFixed(0);
        setError(`Total size too large — max ${mb} MB per upload.`);
        return prev;
      }
      const nextThumbs = incoming.map(makeThumb);
      postAnalytics("site.brief_upload_frames_added", {
        frame_count: projectedCount,
        added_count: incoming.length,
        total_bytes: projectedBytes,
        mimes: incoming.map((f) => f.type).join(","),
      });
      return [...prev, ...nextThumbs];
    });
  }

  function handleFiles(files: File[]): void {
    validateAndAdd(files);
  }

  function handleSingleFile(file: File): void {
    validateAndAdd([file]);
  }

  function handleRemove(id: string): void {
    setThumbs((prev) => {
      const next: ThumbState[] = [];
      for (const t of prev) {
        if (t.id === id) {
          if (t.previewUrl) URL.revokeObjectURL(t.previewUrl);
          continue;
        }
        next.push(t);
      }
      postAnalytics("site.brief_upload_frame_removed", {
        frame_count_after: next.length,
      });
      return next;
    });
  }

  function handleSubmit(): void {
    if (thumbs.length === 0 || disabled) return;
    onSubmit(thumbs.map((t) => t.file));
  }

  const frameCount = thumbs.length;
  const singleFileMode = frameCount <= 1;
  const dropLabel =
    label ??
    (frameCount === 0
      ? "Drop one or more wireframe frames (PNG, JPG, WEBP, or PDF)"
      : `Drop more frames to append (${frameCount}/${maxFrames})`);

  return (
    <div data-testid="multi-frame-uploader">
      <Dropzone
        label={dropLabel}
        accept=""
        acceptImages
        multiple
        onFile={handleSingleFile}
        onFiles={handleFiles}
        disabled={disabled}
        compact
        testId={testId ?? "wireframe-dropzone"}
      />

      {error && (
        <div
          role="alert"
          data-testid="multi-frame-error"
          style={{
            padding: "0.55rem 0.75rem",
            marginTop: "0.5rem",
            background: "rgba(220, 80, 80, 0.08)",
            border: "1px solid rgba(220, 80, 80, 0.4)",
            color: "#e07070",
            borderRadius: "6px",
            fontSize: "0.85rem",
          }}
        >
          {error}
        </div>
      )}

      {frameCount > 0 && (
        <div
          data-testid="multi-frame-thumbnails"
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(92px, 1fr))",
            gap: "0.5rem",
            marginTop: "0.6rem",
          }}
        >
          {thumbs.map((t, i) => (
            <div
              key={t.id}
              data-testid={`multi-frame-thumb-${i}`}
              data-frame-index={i}
              style={{
                position: "relative",
                border: "1px solid var(--wp-border)",
                borderRadius: "6px",
                overflow: "hidden",
                background: "var(--wp-dark)",
                aspectRatio: "4 / 3",
                display: "flex",
                flexDirection: "column",
                justifyContent: "center",
                alignItems: "center",
              }}
            >
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  top: "4px",
                  left: "6px",
                  fontSize: "0.7rem",
                  fontWeight: 700,
                  color: "var(--wp-text)",
                  background: "rgba(0,0,0,0.55)",
                  padding: "0 0.35rem",
                  borderRadius: "4px",
                }}
              >
                {i + 1}
              </span>
              <button
                type="button"
                data-testid={`multi-frame-remove-${i}`}
                aria-label={`Remove frame ${i + 1}`}
                onClick={() => handleRemove(t.id)}
                disabled={disabled}
                style={{
                  position: "absolute",
                  top: "4px",
                  right: "4px",
                  background: "rgba(0,0,0,0.55)",
                  color: "var(--wp-text)",
                  border: "none",
                  borderRadius: "4px",
                  width: "18px",
                  height: "18px",
                  lineHeight: "16px",
                  fontSize: "0.8rem",
                  cursor: disabled ? "not-allowed" : "pointer",
                  padding: 0,
                }}
              >
                ×
              </button>
              {t.previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={t.previewUrl}
                  alt={`Frame ${i + 1} preview: ${t.file.name}`}
                  style={{
                    width: "100%",
                    height: "100%",
                    objectFit: "cover",
                  }}
                />
              ) : (
                <div
                  style={{
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: "0.7rem",
                    color: "var(--wp-text-dim)",
                    padding: "0.5rem",
                    textAlign: "center",
                  }}
                >
                  <div
                    aria-hidden
                    style={{ fontWeight: 700, marginBottom: "0.25rem" }}
                  >
                    PDF
                  </div>
                  <div
                    style={{
                      fontSize: "0.68rem",
                      wordBreak: "break-all",
                      lineHeight: 1.2,
                    }}
                  >
                    {t.file.name}
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {frameCount > 0 && (
        <div
          style={{
            display: "flex",
            gap: "0.5rem",
            alignItems: "center",
            marginTop: "0.7rem",
            flexWrap: "wrap",
          }}
        >
          <button
            type="button"
            data-testid="multi-frame-submit"
            onClick={handleSubmit}
            disabled={disabled}
            style={{
              background: "var(--wp-gold)",
              color: "var(--wp-dark)",
              border: "1px solid var(--wp-border)",
              borderRadius: "6px",
              padding: "0.5rem 0.9rem",
              fontWeight: 600,
              fontSize: "0.85rem",
              cursor: disabled ? "not-allowed" : "pointer",
              opacity: disabled ? 0.6 : 1,
            }}
          >
            {singleFileMode
              ? "Analyze this wireframe"
              : `Analyze ${frameCount} frames`}
          </button>
          <span
            style={{ color: "var(--wp-text-dim)", fontSize: "0.75rem" }}
          >
            {singleFileMode
              ? "Drop more frames above if this is part of a multi-page design."
              : "Order matches upload order. Remove + re-drop to reorder."}
          </span>
        </div>
      )}
    </div>
  );
}

/**
 * FeedbackWidget — confirmation + compose surface for the assistant
 * `/feedback` slash command.
 *
 * Two render states, driven by `spec.mode`:
 *
 *   mode = "recorded"
 *     The slash command carried a body; the tool already wrote the row.
 *     Renders a "Thanks, recorded as #<short>" header + the user's
 *     captured message echoed back so they can verify it landed.
 *
 *   mode = "compose"
 *     The user typed a bare `/feedback`. The widget renders a textarea
 *     + a "Send" button, POSTs to `spec.submitUrl` on click, then swaps
 *     to the recorded state in place once the API returns 201.
 *
 * Analytics: fires `assistant.feedback_widget_opened` on mount and
 * `assistant.feedback_submitted_from_widget` when the compose-mode
 * submit returns 2xx. Both events ride through /api/analytics so they
 * land in instinct_events alongside the server-side tool events.
 */

"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { fetchWithRefresh } from "@/lib/client-auth";
import { MAX_FEEDBACK_LENGTH } from "@/lib/feedback/limits";
import {
  compressImageFile,
  formatBytes,
  isCompressibleImage,
} from "@/lib/assistant/image-compress";
import type { FeedbackWidgetSpec } from "@/lib/assistant/widgets/types";

type RenderMode = "recorded" | "compose";

/** Ceiling for an attached screenshot AFTER client-side compression. The
 *  image is inlined as base64 into the submit body, so this keeps the
 *  request well under the serverless body limit. */
const MAX_SCREENSHOT_BYTES = 480_000;

export interface FeedbackWidgetProps {
  spec: FeedbackWidgetSpec;
  workflowId?: string;
}

interface RecordedState {
  feedbackId: string;
  message: string;
}

/** Attached, compressed screenshot ready to ride the submit body. */
interface ScreenshotState {
  content_type: string;
  data_base64: string;
  byte_size: number;
  /** Local-only: the full data URL + filename for the inline preview.
   *  Not sent to the server (the server rebuilds from data_base64). */
  preview_url: string;
  filename: string;
}

export function FeedbackWidget({ spec, workflowId }: FeedbackWidgetProps) {
  /* The spec is the *initial* state. The widget swaps to recorded
   * locally after a successful compose-mode submit, so we keep both
   * the current mode and the (newly-)recorded payload in state. */
  const [mode, setMode] = useState<RenderMode>(spec.mode);
  const [recorded, setRecorded] = useState<RecordedState | null>(
    spec.mode === "recorded" && spec.feedbackId
      ? { feedbackId: spec.feedbackId, message: spec.message ?? "" }
      : null,
  );
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [screenshot, setScreenshot] = useState<ScreenshotState | null>(null);
  const [screenshotError, setScreenshotError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  /* Synchronous in-flight guard. React state (`submitting`) updates
   * asynchronously, so a fast double-click or two quick Cmd+Enter
   * keystrokes can both enter `submit()` before the disabled state
   * re-renders, producing duplicate rows. The ref is mutated and read
   * synchronously so the second call exits immediately. */
  const inFlightRef = useRef(false);

  /* One-shot mount analytics — the widget being rendered tells the
   * learning loop the user is in feedback mode, regardless of whether
   * they actually submit. Best-effort: a 401 here mustn't crash the
   * widget. */
  useEffect(() => {
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "assistant.feedback_widget_opened",
        metadata: {
          widget_kind: "feedback",
          mode: spec.mode,
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
          widget_kind: "feedback",
          mode: spec.mode,
          ...(workflowId ? { workflow_id: workflowId } : {}),
        },
      }),
    }).catch(() => undefined);
  }, [spec.mode, workflowId]);

  const submit = useCallback(async () => {
    /* Synchronous re-entry guard. Must come BEFORE any async work or
     * any React state mutation, because both are deferred relative to
     * the next click / keystroke. */
    if (inFlightRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      setError("Please write a short note before sending.");
      return;
    }
    inFlightRef.current = true;
    setSubmitting(true);
    setError(null);
    try {
      const res = await fetchWithRefresh(spec.submitUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: trimmed,
          surface: spec.surface ?? "/assistant",
          ...(workflowId ? { workflow_id: workflowId } : {}),
          ...(screenshot
            ? {
                screenshot: {
                  content_type: screenshot.content_type,
                  data_base64: screenshot.data_base64,
                  byte_size: screenshot.byte_size,
                },
              }
            : {}),
        }),
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          detail?: string;
        };
        setError(body.detail || body.error || `request failed (${res.status})`);
        return;
      }
      const body = (await res.json()) as { id: string };
      setRecorded({ feedbackId: body.id, message: trimmed });
      setMode("recorded");
      setDraft("");
      setScreenshot(null);
      setScreenshotError(null);
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "assistant.feedback_submitted_from_widget",
          metadata: {
            widget_kind: "feedback",
            feedback_id: body.id,
            message_length: trimmed.length,
            ...(workflowId ? { workflow_id: workflowId } : {}),
          },
        }),
      }).catch(() => undefined);
    } catch {
      setError("Couldn't reach the server. Please try again.");
    } finally {
      setSubmitting(false);
      inFlightRef.current = false;
    }
  }, [draft, screenshot, spec.submitUrl, spec.surface, workflowId]);

  /* Fire-and-forget widget interaction analytics, matching the uniform
   * pattern every widget uses. A 401 here must never crash the widget. */
  const fireInteraction = useCallback(
    (action: string, value?: number) => {
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          event: "assistant.widget_interaction",
          metadata: {
            widget_kind: "feedback",
            action,
            ...(value !== undefined ? { value } : {}),
            ...(workflowId ? { workflow_id: workflowId } : {}),
          },
        }),
      }).catch(() => undefined);
    },
    [workflowId],
  );

  const onScreenshotSelect = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      /* Allow re-selecting the same file later (onChange won't fire for an
       * identical path otherwise). */
      e.target.value = "";
      if (!file) return;
      setScreenshotError(null);

      if (!isCompressibleImage(file.type)) {
        setScreenshotError(
          "Please attach a PNG, JPG, or WebP screenshot.",
        );
        return;
      }

      let compressed: File;
      try {
        compressed = await compressImageFile(file, {
          maxBytes: MAX_SCREENSHOT_BYTES,
        });
      } catch {
        setScreenshotError(
          "Couldn't process that image. Try a smaller crop.",
        );
        return;
      }

      if (compressed.size > MAX_SCREENSHOT_BYTES) {
        setScreenshotError(
          `That image is ${formatBytes(compressed.size)} after compression, over the 480 KB limit. Try a smaller crop.`,
        );
        return;
      }

      const dataUrl = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result ?? ""));
        reader.onerror = () => reject(new Error("read failed"));
        reader.readAsDataURL(compressed);
      }).catch(() => null);

      if (!dataUrl) {
        setScreenshotError(
          "Couldn't read that image. Try a smaller crop.",
        );
        return;
      }

      const base64 = dataUrl.includes("base64,")
        ? dataUrl.slice(dataUrl.indexOf("base64,") + "base64,".length)
        : "";
      setScreenshot({
        content_type: compressed.type,
        data_base64: base64,
        byte_size: compressed.size,
        preview_url: dataUrl,
        filename: compressed.name,
      });
      fireInteraction("screenshot_attached", compressed.size);
    },
    [fireInteraction],
  );

  const onScreenshotRemove = useCallback(() => {
    setScreenshot(null);
    setScreenshotError(null);
    fireInteraction("screenshot_removed");
  }, [fireInteraction]);

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      /* Defense in depth — submit() also re-checks the ref, but
       * short-circuiting here avoids even firing the keyboard event
       * handler when a submit is already in flight. */
      if (inFlightRef.current) return;
      void submit();
    }
  };

  if (mode === "recorded" && recorded) {
    const shortId = recorded.feedbackId.replace(/-/g, "").slice(0, 8);
    return (
      <div
        data-testid="feedback-widget"
        data-mode="recorded"
        className="mt-2 rounded-md p-3"
        style={{
          background: "var(--wp-dark-surface2, #1a1a1a)",
          border: "1px solid var(--wp-dark-border, #333)",
        }}
      >
        <div
          className="text-sm font-semibold"
          style={{ color: "var(--wp-gold, #eab308)" }}
          data-testid="feedback-widget-thanks"
        >
          Thanks. Feedback recorded as #{shortId}.
        </div>
        <div
          className="text-xs mt-2 whitespace-pre-wrap"
          style={{ color: "var(--wp-text-dim, #aaa)" }}
          data-testid="feedback-widget-echo"
        >
          {recorded.message}
        </div>
        <div
          className="text-[10px] mt-2"
          style={{ color: "var(--wp-text-muted, #6b7280)" }}
        >
          Captured for the team. The CTO sees every note.
        </div>
      </div>
    );
  }

  /* mode === "compose" (or recorded with no payload, defensive fallback) */
  const remaining = MAX_FEEDBACK_LENGTH - draft.length;
  const disabled = submitting || draft.trim().length === 0;
  return (
    <div
      data-testid="feedback-widget"
      data-mode="compose"
      className="mt-2 rounded-md p-3"
      style={{
        background: "var(--wp-dark-surface2, #1a1a1a)",
        border: "1px solid var(--wp-dark-border, #333)",
      }}
    >
      <div
        className="text-sm font-semibold mb-2"
        style={{ color: "var(--wp-text, #eee)" }}
      >
        Share feedback with the team
      </div>
      <textarea
        ref={textareaRef}
        data-testid="feedback-widget-textarea"
        value={draft}
        onChange={(e) => setDraft(e.target.value.slice(0, MAX_FEEDBACK_LENGTH))}
        onKeyDown={onKeyDown}
        placeholder="What would make Instinct better for you?"
        rows={4}
        /* readOnly during submit so the user can't edit + retry mid-
         * flight, which would otherwise change the body and bypass the
         * server-side dedup window. */
        readOnly={submitting}
        className="w-full rounded p-2 text-xs"
        style={{
          background: "var(--wp-dark, #111)",
          border: "1px solid var(--wp-dark-border, #333)",
          color: "var(--wp-text, #eee)",
          resize: "vertical",
          opacity: submitting ? 0.7 : 1,
        }}
      />
      {/* Optional screenshot attachment. Single image only: attaching a
          second replaces the first. */}
      <div className="mt-2">
        <input
          ref={fileInputRef}
          data-testid="feedback-screenshot-input"
          type="file"
          accept="image/*"
          onChange={(e) => void onScreenshotSelect(e)}
          style={{ display: "none" }}
        />
        {!screenshot ? (
          <button
            type="button"
            data-testid="feedback-screenshot-attach"
            onClick={() => fileInputRef.current?.click()}
            disabled={submitting}
            className="text-[11px] px-2 py-1 rounded-md transition-colors"
            style={{
              background: "var(--wp-dark, #111)",
              border: "1px solid var(--wp-dark-border, #333)",
              color: "var(--wp-text-dim, #aaa)",
              cursor: submitting ? "not-allowed" : "pointer",
            }}
          >
            Attach screenshot (optional)
          </button>
        ) : (
          <div
            data-testid="feedback-screenshot-preview"
            className="flex items-center gap-2 rounded-md p-2"
            style={{
              background: "var(--wp-dark, #111)",
              border: "1px solid var(--wp-dark-border, #333)",
            }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element -- data-URL
                thumbnail of an in-memory File; next/image needs a real src. */}
            <img
              src={screenshot.preview_url}
              alt="Attached screenshot preview"
              className="rounded"
              style={{
                width: 40,
                height: 40,
                objectFit: "cover",
                border: "1px solid var(--wp-dark-border, #333)",
              }}
            />
            <span
              className="text-[11px] flex-1 truncate"
              style={{ color: "var(--wp-text-dim, #aaa)" }}
              data-testid="feedback-screenshot-meta"
            >
              {screenshot.filename} ({formatBytes(screenshot.byte_size)})
            </span>
            <button
              type="button"
              data-testid="feedback-screenshot-remove"
              onClick={onScreenshotRemove}
              disabled={submitting}
              aria-label="Remove screenshot"
              className="text-xs px-2 py-0.5 rounded"
              style={{
                background: "transparent",
                border: "1px solid var(--wp-dark-border, #333)",
                color: "var(--wp-text-muted, #6b7280)",
                cursor: submitting ? "not-allowed" : "pointer",
              }}
            >
              ✕
            </button>
          </div>
        )}
        {screenshotError && (
          <div
            data-testid="feedback-screenshot-error"
            className="text-xs mt-2"
            style={{ color: "#f87171" }}
          >
            {screenshotError}
          </div>
        )}
      </div>
      <div
        className="flex items-center justify-between mt-2"
        style={{ color: "var(--wp-text-muted, #6b7280)" }}
      >
        <span className="text-[10px]" data-testid="feedback-widget-remaining">
          {remaining} characters left
        </span>
        <button
          type="button"
          data-testid="feedback-widget-submit"
          onClick={() => void submit()}
          disabled={disabled}
          className="text-xs px-3 py-1 rounded-md transition-colors"
          style={{
            background: disabled
              ? "rgba(234,179,8,0.04)"
              : "rgba(234,179,8,0.12)",
            color: disabled ? "var(--wp-text-muted, #6b7280)" : "var(--wp-gold, #eab308)",
            border: "1px solid rgba(234,179,8,0.35)",
            cursor: disabled ? "not-allowed" : "pointer",
          }}
        >
          {submitting ? "Sending..." : "Send"}
        </button>
      </div>
      {error && (
        <div
          data-testid="feedback-widget-error"
          className="text-xs mt-2"
          style={{ color: "#f87171" }}
        >
          {error}
        </div>
      )}
    </div>
  );
}

"use client";

/**
 * GenerateImageModal — AI image generator for Sites.
 *
 * Non-technical team members click the "Generate image" button next to
 * an image URL field (hero.backgroundImage or gallery[i].src) in
 * BriefForm; this modal opens, asks for a plain-English description +
 * aspect ratio, calls the /api/sites/[id]/generate-image endpoint,
 * shows a preview of the result, and either drops the URL back into
 * the brief ("Use this image") or lets them iterate ("Try another").
 *
 * Every interaction fires an analytics event (site.image_gen_opened,
 * submitted, accepted, regenerated, dismissed) so the brain learns
 * which prompts land on first try, which iterate, which get
 * abandoned — all of which feeds the "which prompts work?" insight
 * for non-technical users.
 *
 * Zero-tokens rule: this component does no AI work itself. It's a
 * UI over an already-authed fetch. The server route + image-gen.ts
 * wrap the only paid call (fal.ai).
 */

import { useState, useEffect, useId } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";

// Mirrors MAX_PROMPT_LEN in src/lib/image-gen.ts. We keep a client-safe
// copy here so the modal doesn't transitively pull node:crypto / pg
// into the browser bundle (same defence-in-depth pattern as sites.ts
// re-exporting from sites-schema.ts for client usage).
export const MAX_PROMPT_LEN = 500;

// 5 aspect-ratio presets + their 40 x (ratio-correct) thumbnail
// placeholders. Plain aspect-ratio boxes render faster than SVG tiles
// and keep the bundle slim.
export const ASPECTS = [
  { value: "16:9", label: "Wide (16:9)", w: 48, h: 27 },
  { value: "4:3", label: "Landscape (4:3)", w: 40, h: 30 },
  { value: "1:1", label: "Square (1:1)", w: 32, h: 32 },
  { value: "3:4", label: "Portrait (3:4)", w: 27, h: 36 },
  { value: "9:16", label: "Tall (9:16)", w: 20, h: 36 },
] as const;

export type AspectRatio = (typeof ASPECTS)[number]["value"];

export interface GenerateImageModalProps {
  open: boolean;
  projectId: string;
  sectionPath: string; // e.g. /pages/0/sections/0/backgroundImage — recorded for learning
  onClose: () => void;
  onAccept: (url: string, generationId: string) => void;
  // Override fetch implementation — unit tests use this to skip the
  // fetchWithRefresh layer.
  fetchImpl?: typeof fetch;
}

interface GenerationState {
  status: "idle" | "loading" | "ready" | "error";
  url?: string;
  generationId?: string;
  errorMessage?: string;
  errorReason?: string;
}

function fireAnalytics(
  event: string,
  metadata: Record<string, string | number | boolean>,
): void {
  if (typeof window === "undefined") return;
  fetchWithRefresh("/api/analytics", {
    method: "POST",
    headers: jsonHeaders(),
    body: JSON.stringify({ event, metadata }),
  }).catch(() => {
    /* analytics is best-effort — never block the editor */
  });
}

export function GenerateImageModal({
  open,
  projectId,
  sectionPath,
  onClose,
  onAccept,
  fetchImpl,
}: GenerateImageModalProps) {
  const [prompt, setPrompt] = useState("");
  const [aspectRatio, setAspectRatio] = useState<AspectRatio>("16:9");
  const [state, setState] = useState<GenerationState>({ status: "idle" });
  const promptId = useId();
  const aspectId = useId();

  // Fire the `opened` event once per open transition. Dependency on
  // `open` only — we do not emit again when the parent re-renders.
  useEffect(() => {
    if (!open) return;
    fireAnalytics("site.image_gen_opened", {
      project_id: projectId,
      section_path: sectionPath,
    });
    // reset per-open state so a stale success doesn't linger.
    setState({ status: "idle" });
    setPrompt("");
    setAspectRatio("16:9");
  }, [open, projectId, sectionPath]);

  if (!open) return null;

  async function submit(intent: "initial" | "regenerate") {
    const trimmed = prompt.trim();
    if (trimmed.length === 0) {
      setState({
        status: "error",
        errorMessage: "Please describe the image you want.",
        errorReason: "prompt_required",
      });
      return;
    }
    if (trimmed.length > MAX_PROMPT_LEN) {
      setState({
        status: "error",
        errorMessage: `Prompt is ${trimmed.length} characters — max is ${MAX_PROMPT_LEN}.`,
        errorReason: "prompt_too_long",
      });
      return;
    }

    setState({ status: "loading" });
    fireAnalytics(
      intent === "regenerate"
        ? "site.image_gen_regenerated"
        : "site.image_gen_submitted",
      {
        project_id: projectId,
        section_path: sectionPath,
        prompt_length: trimmed.length,
        aspect_ratio: aspectRatio,
      },
    );

    try {
      const doFetch = fetchImpl ?? fetchWithRefresh;
      const res = await doFetch(
        `/api/sites/${encodeURIComponent(projectId)}/generate-image`,
        {
          method: "POST",
          headers: jsonHeaders(),
          body: JSON.stringify({
            prompt: trimmed,
            aspectRatio,
            sectionPath,
          }),
        },
      );
      const data = (await res.json().catch(() => ({}))) as {
        url?: string;
        generationId?: string;
        error?: string;
        reason?: string;
      };
      if (!res.ok) {
        setState({
          status: "error",
          errorMessage: data.error ?? `Request failed (${res.status}).`,
          errorReason: data.reason,
        });
        return;
      }
      if (!data.url || !data.generationId) {
        setState({
          status: "error",
          errorMessage: "Server returned an empty image.",
          errorReason: "empty_response",
        });
        return;
      }
      setState({
        status: "ready",
        url: data.url,
        generationId: data.generationId,
      });
    } catch (err) {
      setState({
        status: "error",
        errorMessage: (err as Error).message || "Network error.",
        errorReason: "network",
      });
    }
  }

  function accept() {
    if (state.status !== "ready" || !state.url || !state.generationId) return;
    fireAnalytics("site.image_gen_accepted", {
      project_id: projectId,
      section_path: sectionPath,
      generation_id: state.generationId,
    });
    onAccept(state.url, state.generationId);
    onClose();
  }

  function dismiss() {
    fireAnalytics("site.image_gen_dismissed", {
      project_id: projectId,
      section_path: sectionPath,
      had_result: state.status === "ready",
    });
    onClose();
  }

  const charCount = prompt.length;
  const charColor = charCount > MAX_PROMPT_LEN ? "#c44" : "var(--wp-text-dim)";

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby={`${promptId}-title`}
      data-generate-image-modal
      onClick={dismiss}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.7)",
        zIndex: 1000,
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        padding: "1rem",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          background: "var(--wp-card, #1a1a1a)",
          color: "var(--wp-text, #fff)",
          border: "1px solid var(--wp-border, #333)",
          borderRadius: "8px",
          padding: "1.25rem",
          width: "100%",
          maxWidth: "560px",
          maxHeight: "90vh",
          overflowY: "auto",
          display: "grid",
          gap: "1rem",
        }}
      >
        <div>
          <h3
            id={`${promptId}-title`}
            style={{ margin: 0, fontSize: "1.05rem" }}
          >
            ✨ Generate image
          </h3>
          <p
            style={{
              margin: "0.3rem 0 0",
              fontSize: "0.8rem",
              color: "var(--wp-text-dim, #aaa)",
            }}
          >
            Describe what you want — the AI creates it in about 3-5 seconds.
          </p>
        </div>

        <div>
          <label
            htmlFor={promptId}
            style={{
              display: "block",
              fontSize: "0.75rem",
              color: "var(--wp-text-dim, #aaa)",
              marginBottom: "0.3rem",
            }}
          >
            Describe the image you want
          </label>
          <textarea
            id={promptId}
            name={promptId}
            aria-label="Describe the image you want"
            placeholder="e.g. A modern minimalist office with warm natural light, clean desks, laptops."
            value={prompt}
            maxLength={MAX_PROMPT_LEN + 50}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={state.status === "loading"}
            style={{
              width: "100%",
              minHeight: "100px",
              padding: "0.6rem",
              background: "var(--wp-dark, #0d0d0d)",
              color: "inherit",
              border: "1px solid var(--wp-border, #333)",
              borderRadius: "5px",
              fontSize: "0.85rem",
              fontFamily: "inherit",
              resize: "vertical",
            }}
          />
          <div
            style={{
              fontSize: "0.7rem",
              color: charColor,
              marginTop: "0.2rem",
              textAlign: "right",
            }}
          >
            {charCount} / {MAX_PROMPT_LEN}
          </div>
        </div>

        <div>
          <label
            htmlFor={aspectId}
            style={{
              display: "block",
              fontSize: "0.75rem",
              color: "var(--wp-text-dim, #aaa)",
              marginBottom: "0.3rem",
            }}
          >
            Aspect ratio
          </label>
          <div
            id={aspectId}
            role="radiogroup"
            aria-label="Aspect ratio"
            style={{
              display: "flex",
              flexWrap: "wrap",
              gap: "0.5rem",
            }}
          >
            {ASPECTS.map((opt) => {
              const selected = aspectRatio === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  data-aspect-ratio={opt.value}
                  onClick={() => setAspectRatio(opt.value)}
                  disabled={state.status === "loading"}
                  style={{
                    padding: "0.4rem 0.6rem",
                    background: selected
                      ? "var(--wp-gold, #c9a34a)"
                      : "var(--wp-dark, #0d0d0d)",
                    color: selected ? "#000" : "inherit",
                    border: `1px solid ${
                      selected ? "var(--wp-gold, #c9a34a)" : "var(--wp-border, #333)"
                    }`,
                    borderRadius: "4px",
                    fontSize: "0.75rem",
                    cursor: "pointer",
                    display: "flex",
                    alignItems: "center",
                    gap: "0.4rem",
                  }}
                >
                  <span
                    aria-hidden="true"
                    style={{
                      display: "inline-block",
                      width: `${opt.w / 2}px`,
                      height: `${opt.h / 2}px`,
                      background: selected ? "#000" : "var(--wp-text-dim, #aaa)",
                      borderRadius: "1px",
                    }}
                  />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {state.status === "idle" && (
          <div style={{ display: "flex", gap: "0.5rem", justifyContent: "flex-end" }}>
            <button
              type="button"
              onClick={dismiss}
              style={btnGhost()}
              data-action="cancel"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => submit("initial")}
              style={btnPrimary()}
              data-action="generate"
            >
              Generate
            </button>
          </div>
        )}

        {state.status === "loading" && (
          <div
            data-loading
            style={{
              display: "flex",
              alignItems: "center",
              gap: "0.6rem",
              padding: "0.75rem",
              background: "var(--wp-dark, #0d0d0d)",
              borderRadius: "5px",
              fontSize: "0.85rem",
            }}
          >
            <span
              aria-hidden="true"
              style={{
                display: "inline-block",
                width: "14px",
                height: "14px",
                border: "2px solid var(--wp-border, #333)",
                borderTopColor: "var(--wp-gold, #c9a34a)",
                borderRadius: "50%",
                animation: "spin 1s linear infinite",
              }}
            />
            Creating your image… this usually takes 3-5 seconds.
          </div>
        )}

        {state.status === "ready" && state.url && (
          <div style={{ display: "grid", gap: "0.6rem" }}>
            <div
              style={{
                padding: "0.4rem",
                background: "var(--wp-dark, #0d0d0d)",
                borderRadius: "5px",
                display: "flex",
                justifyContent: "center",
              }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={state.url}
                alt="Generated preview"
                data-generated-preview
                style={{
                  maxWidth: "100%",
                  maxHeight: "400px",
                  width: "auto",
                  height: "auto",
                  borderRadius: "4px",
                }}
              />
            </div>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-end",
                flexWrap: "wrap",
              }}
            >
              <button
                type="button"
                onClick={dismiss}
                style={btnGhost()}
                data-action="cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => submit("regenerate")}
                style={btnSecondary()}
                data-action="regenerate"
              >
                Try another variation
              </button>
              <button
                type="button"
                onClick={accept}
                style={btnSuccess()}
                data-action="accept"
              >
                Use this image
              </button>
            </div>
          </div>
        )}

        {state.status === "error" && (
          <div
            data-error
            style={{
              padding: "0.75rem",
              background: "rgba(204,68,68,0.12)",
              border: "1px solid #c44",
              borderRadius: "5px",
              color: "#ff8585",
              fontSize: "0.85rem",
            }}
          >
            <div style={{ fontWeight: 600, marginBottom: "0.3rem" }}>
              Image generation failed
            </div>
            <div>{state.errorMessage}</div>
            <div
              style={{
                display: "flex",
                gap: "0.5rem",
                justifyContent: "flex-end",
                marginTop: "0.75rem",
              }}
            >
              <button
                type="button"
                onClick={dismiss}
                style={btnGhost()}
                data-action="cancel"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => submit("initial")}
                style={btnPrimary()}
                data-action="retry"
              >
                Try again
              </button>
            </div>
          </div>
        )}
      </div>
      <style>{`
        @keyframes spin { to { transform: rotate(360deg); } }
        @media (max-width: 600px) {
          [data-generate-image-modal] > div { padding: 1rem !important; }
        }
      `}</style>
    </div>
  );
}

// Minimal button helpers — reuse token names from BriefForm so the
// modal's theme stays consistent with the rest of the Sites editor.
function btnPrimary(): React.CSSProperties {
  return {
    padding: "0.5rem 0.9rem",
    background: "var(--wp-gold, #c9a34a)",
    color: "#000",
    border: "1px solid var(--wp-gold, #c9a34a)",
    borderRadius: "5px",
    fontSize: "0.8rem",
    cursor: "pointer",
    fontWeight: 600,
  };
}
function btnSuccess(): React.CSSProperties {
  return {
    padding: "0.5rem 0.9rem",
    background: "#2f9e44",
    color: "#fff",
    border: "1px solid #2f9e44",
    borderRadius: "5px",
    fontSize: "0.8rem",
    cursor: "pointer",
    fontWeight: 600,
  };
}
function btnSecondary(): React.CSSProperties {
  return {
    padding: "0.5rem 0.9rem",
    background: "var(--wp-card, #1a1a1a)",
    color: "inherit",
    border: "1px solid var(--wp-border, #333)",
    borderRadius: "5px",
    fontSize: "0.8rem",
    cursor: "pointer",
  };
}
function btnGhost(): React.CSSProperties {
  return {
    padding: "0.5rem 0.9rem",
    background: "transparent",
    color: "inherit",
    border: "1px solid transparent",
    borderRadius: "5px",
    fontSize: "0.8rem",
    cursor: "pointer",
  };
}

export default GenerateImageModal;

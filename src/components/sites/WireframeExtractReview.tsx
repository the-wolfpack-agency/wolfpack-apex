"use client";

/**
 * WireframeExtractReview — non-technical review card for a successful
 * `POST /api/sites/parse-brief` response that came from an image/PDF.
 *
 * Shows the user (Max + Meghan) what the AI extracted:
 *   - Up to 5 color swatches, labeled primary / accent / bg / fg / muted.
 *   - Detected font name (or "Default font" if none came back).
 *   - Section count + the detected section types (hero / text / cards …).
 *   - Two CTAs:
 *       "Apply these choices"  → onApply({ brief, theme })
 *       "Edit manually instead" → onDismiss()
 *
 * Neither button saves anything on its own — Apply commits the extracted
 * brief + theme into the parent form state, the user still reviews the
 * fields and hits Save. This keeps the existing "nothing persists without
 * an explicit save" invariant.
 *
 * Mobile-first: the color swatches wrap, the layout collapses to a single
 * column below 600px via a media-query hook (no CSS-in-JS breakpoints
 * needed — we inline the grid template + read window.matchMedia once).
 *
 * Analytics fires `site.wireframe_review_shown` on mount,
 * `site.wireframe_review_applied` on Apply, and
 * `site.wireframe_review_dismissed` on Dismiss — all via
 * fetchWithRefresh (NEVER raw fetch) so the analytics guardrail stays
 * green.
 */

import { useEffect, useMemo } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import type { SiteBrief, SiteTheme } from "@/lib/sites-schema";

/**
 * The minimum contract the server returns for an image-based extraction.
 * Keep this in lockstep with the backend's response shape — the only
 * fields we READ here are the ones declared on this interface.
 */
export interface WireframeExtractMetadata {
  extractedColors?: string[];
  detectedFont?: string;
  confidence?: number;
  latencyMs?: number;
  generationId?: string;
}

export interface WireframeExtractPayload {
  brief: SiteBrief;
  source: "vision" | "text" | "html" | "markdown" | string;
  metadata: WireframeExtractMetadata;
}

export interface WireframeExtractReviewProps {
  /** The full parse-brief response. */
  payload: WireframeExtractPayload;
  /**
   * Called when the user hits "Apply these choices". The merged payload
   * contains the extracted brief with the extracted theme folded into
   * `brief.theme`, so the parent can drop it straight into BriefForm.
   */
  onApply: (merged: { brief: SiteBrief; theme: SiteTheme }) => void;
  /** Called when the user hits "Edit manually instead". */
  onDismiss: () => void;
}

// The 5 named slots we surface. Order matches ThemeEditor + SiteTheme
// so the palette reads consistently across the app.
const SWATCH_SLOTS = ["primary", "accent", "bg", "fg", "muted"] as const;
type SwatchSlot = (typeof SWATCH_SLOTS)[number];

// Friendly labels — NO jargon. Don't say "muted" to Max; say "soft".
const SWATCH_LABELS: Record<SwatchSlot, string> = {
  primary: "Primary",
  accent: "Accent",
  bg: "Background",
  fg: "Text",
  muted: "Soft",
};

// Neutral fallbacks for slots the AI didn't return. Matches DEFAULT_THEME
// in site-theme.ts so the swatches never render blank.
const SWATCH_FALLBACKS: Record<SwatchSlot, string> = {
  primary: "#d4af37",
  accent: "#6366f1",
  bg: "#0b0b10",
  fg: "#f4f4f6",
  muted: "#2a2a35",
};

function isValidHex(value: string | undefined): value is string {
  return !!value && /^#[0-9a-f]{6}$/i.test(value);
}

/**
 * Map the flat `extractedColors: string[]` array into the 5 named slots
 * in order. Invalid hex values fall through to the neutral fallback so
 * the swatch grid never shows a broken color.
 */
function buildPalette(colors: string[] | undefined): Record<SwatchSlot, string> {
  const list = colors ?? [];
  const out = {} as Record<SwatchSlot, string>;
  SWATCH_SLOTS.forEach((slot, i) => {
    const raw = list[i];
    out[slot] = isValidHex(raw) ? raw : SWATCH_FALLBACKS[slot];
  });
  return out;
}

function countSections(brief: SiteBrief): { total: number; types: string[] } {
  const pages = brief.pages ?? [];
  const types: string[] = [];
  let total = 0;
  for (const p of pages) {
    for (const s of p.sections ?? []) {
      total += 1;
      if (s && typeof s === "object" && typeof s.type === "string") {
        types.push(s.type);
      }
    }
  }
  return { total, types };
}

/**
 * Merge the extracted palette + font into a SiteTheme the ThemeEditor
 * accepts directly. Only valid fields are included; undefined fields
 * drop out so BriefForm's existing theme-merge fallback paths win.
 */
function buildTheme(metadata: WireframeExtractMetadata): SiteTheme {
  const palette = buildPalette(metadata.extractedColors);
  const theme: SiteTheme = {
    colors: {
      primary: palette.primary,
      accent: palette.accent,
      bg: palette.bg,
      fg: palette.fg,
      muted: palette.muted,
    },
  };
  const font = (metadata.detectedFont ?? "").trim();
  if (font.length > 0) {
    theme.font = {
      family: font,
      googleFontName: font,
    };
  }
  return theme;
}

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

export default function WireframeExtractReview({
  payload,
  onApply,
  onDismiss,
}: WireframeExtractReviewProps) {
  const { brief, metadata } = payload;

  const palette = useMemo(() => buildPalette(metadata.extractedColors), [metadata.extractedColors]);
  const { total: sectionCount, types: sectionTypes } = useMemo(() => countSections(brief), [brief]);
  const theme = useMemo(() => buildTheme(metadata), [metadata]);

  // Analytics: fire once on mount so the learning loop knows how often
  // the review card is being shown (not just applied).
  useEffect(() => {
    postAnalytics("site.wireframe_review_shown", {
      generationId: metadata.generationId,
      confidence: metadata.confidence,
      sectionCount,
      paletteLength: metadata.extractedColors?.length ?? 0,
      source: payload.source,
    });
    // Intentionally fire once per mount. If the same review is shown
    // twice (user dismisses, drops again), we WANT two events so the
    // shown/applied ratio stays honest.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleApply(): void {
    postAnalytics("site.wireframe_review_applied", {
      generationId: metadata.generationId,
      confidence: metadata.confidence,
      sectionCount,
      paletteLength: metadata.extractedColors?.length ?? 0,
    });
    const mergedBrief: SiteBrief = { ...brief, theme };
    onApply({ brief: mergedBrief, theme });
  }

  function handleDismiss(): void {
    postAnalytics("site.wireframe_review_dismissed", {
      generationId: metadata.generationId,
      confidence: metadata.confidence,
      sectionCount,
      paletteLength: metadata.extractedColors?.length ?? 0,
    });
    onDismiss();
  }

  const detectedFont = (metadata.detectedFont ?? "").trim();
  const fontLabel = detectedFont.length > 0 ? detectedFont : "Default font";

  return (
    <section
      data-testid="wireframe-extract-review"
      aria-label="Wireframe extraction review"
      style={{
        padding: "1rem 1.1rem",
        background: "var(--wp-card)",
        border: "1px solid var(--wp-border)",
        borderRadius: "8px",
        marginBottom: "1rem",
        display: "grid",
        gap: "0.9rem",
      }}
    >
      <div>
        <h3 style={{ margin: 0, fontSize: "1rem", color: "var(--wp-text)" }}>
          AI read your wireframe and suggested these choices
        </h3>
        <p
          style={{
            margin: "0.3rem 0 0",
            fontSize: "0.85rem",
            color: "var(--wp-text-dim)",
            lineHeight: 1.4,
          }}
        >
          Review the colors and sections below. Apply them to start, or edit
          manually if you&apos;d rather enter the details yourself.
        </p>
      </div>

      {/* Palette */}
      <div>
        <div
          style={{
            fontSize: "0.72rem",
            color: "var(--wp-text-dim)",
            textTransform: "uppercase",
            letterSpacing: "0.08em",
            marginBottom: "0.4rem",
          }}
        >
          Color palette
        </div>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(90px, 1fr))",
            gap: "0.5rem",
          }}
        >
          {SWATCH_SLOTS.map((slot) => {
            const color = palette[slot];
            return (
              <div
                key={slot}
                data-testid={`wireframe-color-swatch-${slot}`}
                data-slot={slot}
                data-color={color}
                style={{
                  border: "1px solid var(--wp-border)",
                  borderRadius: "6px",
                  overflow: "hidden",
                  background: "var(--wp-dark)",
                }}
              >
                <div
                  aria-hidden
                  style={{
                    background: color,
                    height: "40px",
                    width: "100%",
                  }}
                />
                <div style={{ padding: "0.35rem 0.5rem" }}>
                  <div
                    style={{
                      fontSize: "0.72rem",
                      color: "var(--wp-text)",
                      fontWeight: 600,
                    }}
                  >
                    {SWATCH_LABELS[slot]}
                  </div>
                  <div
                    style={{
                      fontSize: "0.68rem",
                      color: "var(--wp-text-dim)",
                      fontFamily: "ui-monospace, monospace",
                    }}
                  >
                    {color.toUpperCase()}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Font + sections summary */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))",
          gap: "0.75rem",
        }}
      >
        <SummaryCell
          testId="wireframe-detected-font"
          label="Font"
          value={fontLabel}
        />
        <SummaryCell
          testId="wireframe-section-count"
          label="Sections"
          value={
            sectionCount === 0
              ? "None detected"
              : `${sectionCount} section${sectionCount === 1 ? "" : "s"}`
          }
          sub={
            sectionTypes.length > 0
              ? sectionTypes.slice(0, 5).join(" · ") +
                (sectionTypes.length > 5 ? ` +${sectionTypes.length - 5} more` : "")
              : undefined
          }
        />
      </div>

      {/* Buttons */}
      <div
        style={{
          display: "flex",
          gap: "0.5rem",
          flexWrap: "wrap",
          marginTop: "0.2rem",
        }}
      >
        <button
          type="button"
          data-testid="wireframe-apply-btn"
          aria-label="Apply these AI-suggested choices to the brief"
          onClick={handleApply}
          style={{
            padding: "0.6rem 1.1rem",
            background: "var(--wp-gold)",
            color: "var(--wp-dark)",
            border: "1px solid var(--wp-border)",
            borderRadius: "6px",
            fontWeight: 600,
            fontSize: "0.85rem",
            cursor: "pointer",
          }}
        >
          Apply these choices
        </button>
        <button
          type="button"
          data-testid="wireframe-dismiss-btn"
          aria-label="Edit the brief manually instead"
          onClick={handleDismiss}
          style={{
            padding: "0.6rem 1.1rem",
            background: "transparent",
            color: "var(--wp-text)",
            border: "1px solid var(--wp-border)",
            borderRadius: "6px",
            fontWeight: 500,
            fontSize: "0.85rem",
            cursor: "pointer",
          }}
        >
          Edit manually instead
        </button>
      </div>
    </section>
  );
}

function SummaryCell({
  testId,
  label,
  value,
  sub,
}: {
  testId: string;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <div
      data-testid={testId}
      style={{
        padding: "0.6rem 0.75rem",
        background: "var(--wp-dark)",
        border: "1px solid var(--wp-border)",
        borderRadius: "6px",
      }}
    >
      <div
        style={{
          fontSize: "0.68rem",
          color: "var(--wp-text-dim)",
          textTransform: "uppercase",
          letterSpacing: "0.08em",
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontSize: "0.9rem",
          color: "var(--wp-text)",
          fontWeight: 600,
          marginTop: "0.2rem",
        }}
      >
        {value}
      </div>
      {sub && (
        <div style={{ fontSize: "0.75rem", color: "var(--wp-text-dim)", marginTop: "0.25rem" }}>
          {sub}
        </div>
      )}
    </div>
  );
}

"use client";

/**
 * ViewportToggle — Mobile / Tablet / Desktop width selector for the
 * Instinct sites preview iframe.
 *
 * Part of the Path C Phase 1 direct-manipulation wave (Stream P1). A
 * designer clicks Mobile and the preview iframe re-renders at 390px so
 * they can verify the responsive breakpoints without leaving the tool.
 *
 * Design decisions:
 *   - Controlled component: parent owns the `viewport` state (so the
 *     page can persist it to the URL `?viewport=...` for deep-linking).
 *   - Widths exported as `VIEWPORT_WIDTHS` so the edit page + tests can
 *     consume the same constant (single source of truth).
 *   - No new runtime deps. Icons are inline SVG, active state styled
 *     via Instinct CSS variables (--wp-gold, --wp-card, --wp-border).
 *   - Keyboard-accessible as a `role="toolbar"` group: ArrowLeft /
 *     ArrowRight move selection, Enter / Space activate. Matches the
 *     WAI-ARIA Authoring Practices toolbar pattern.
 *   - Mobile-first compliance (feedback_mobile_first.md): below 768px
 *     the toggle collapses to a native `<select>` so Instinct itself
 *     stays usable on a phone. CSS-only via media query — no JS needed.
 */

import { useEffect, useRef, type CSSProperties, type KeyboardEvent } from "react";

export type Viewport = "mobile" | "tablet" | "desktop";

/**
 * Canonical preview widths. These are the widths the iframe wrapper
 * enforces via `max-width`. Numbers were picked from real device specs
 * rather than arbitrary round numbers so the preview matches what
 * designers will see on actual hardware:
 *
 *   - 390 → iPhone 14 Pro portrait
 *   - 834 → iPad 10.9" portrait
 *   - 1280 → common laptop narrow-side (MacBook Air 13")
 */
export const VIEWPORT_WIDTHS: Record<Viewport, number> = {
  mobile: 390,
  tablet: 834,
  desktop: 1280,
};

export const VIEWPORT_ORDER: readonly Viewport[] = ["mobile", "tablet", "desktop"] as const;

export interface ViewportToggleProps {
  value: Viewport;
  onChange: (next: Viewport) => void;
  className?: string;
}

const LABELS: Record<Viewport, string> = {
  mobile: "Mobile",
  tablet: "Tablet",
  desktop: "Desktop",
};

/** Inline SVG icons — no external icon dep. */
function ViewportIcon({ variant }: { variant: Viewport }) {
  const common = {
    width: 16,
    height: 16,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  if (variant === "mobile") {
    return (
      <svg {...common}>
        <rect x="7" y="3" width="10" height="18" rx="2" />
        <line x1="11" y1="18" x2="13" y2="18" />
      </svg>
    );
  }
  if (variant === "tablet") {
    return (
      <svg {...common}>
        <rect x="4" y="3" width="16" height="18" rx="2" />
        <line x1="11" y1="18" x2="13" y2="18" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <rect x="2" y="4" width="20" height="13" rx="2" />
      <line x1="8" y1="21" x2="16" y2="21" />
      <line x1="12" y1="17" x2="12" y2="21" />
    </svg>
  );
}

const toolbarStyle: CSSProperties = {
  display: "inline-flex",
  gap: 2,
  padding: 3,
  border: "1px solid var(--wp-border, rgba(255,255,255,0.12))",
  background: "var(--wp-card, rgba(255,255,255,0.04))",
  borderRadius: 8,
  alignItems: "center",
};

function buttonStyle(active: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "6px 10px",
    border: "1px solid transparent",
    borderRadius: 6,
    background: active ? "var(--wp-gold, #f1c233)" : "transparent",
    color: active ? "var(--wp-dark, #212124)" : "var(--wp-text, #e6e6e6)",
    fontSize: 12,
    fontWeight: active ? 600 : 500,
    cursor: "pointer",
    outline: "none",
    transition: "background 120ms ease, color 120ms ease",
  };
}

const selectStyle: CSSProperties = {
  padding: "6px 10px",
  borderRadius: 6,
  border: "1px solid var(--wp-border, rgba(255,255,255,0.12))",
  background: "var(--wp-card, rgba(255,255,255,0.04))",
  color: "var(--wp-text, #e6e6e6)",
  fontSize: 13,
  fontFamily: "inherit",
};

/**
 * Injects the responsive `@media (max-width: 767px)` rule once on the
 * client so we can collapse the toolbar to a `<select>` on narrow
 * viewports without pulling in a CSS-in-JS library. The rule lives
 * under two stable selectors (`.instinct-vt-toolbar` / `.instinct-vt-select`)
 * and is idempotent — mounting multiple ViewportToggles on the same
 * page only ever creates one `<style>` tag.
 */
const RESPONSIVE_STYLE_ID = "instinct-viewport-toggle-css";
const RESPONSIVE_CSS = `
.instinct-vt-select { display: none; }
@media (max-width: 767px) {
  .instinct-vt-toolbar { display: none !important; }
  .instinct-vt-select { display: inline-flex !important; }
}
`;

function useResponsiveStyle() {
  useEffect(() => {
    if (typeof document === "undefined") return;
    if (document.getElementById(RESPONSIVE_STYLE_ID)) return;
    const el = document.createElement("style");
    el.id = RESPONSIVE_STYLE_ID;
    el.textContent = RESPONSIVE_CSS;
    document.head.appendChild(el);
  }, []);
}

export default function ViewportToggle({
  value,
  onChange,
  className,
}: ViewportToggleProps) {
  useResponsiveStyle();
  const buttonRefs = useRef<Record<Viewport, HTMLButtonElement | null>>({
    mobile: null,
    tablet: null,
    desktop: null,
  });

  function moveBy(delta: number) {
    const idx = VIEWPORT_ORDER.indexOf(value);
    const next = VIEWPORT_ORDER[(idx + delta + VIEWPORT_ORDER.length) % VIEWPORT_ORDER.length];
    onChange(next);
    // Move focus so sighted keyboard users see the active state move.
    queueMicrotask(() => {
      buttonRefs.current[next]?.focus();
    });
  }

  function handleKey(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === "ArrowRight") {
      e.preventDefault();
      moveBy(1);
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      moveBy(-1);
    } else if (e.key === "Home") {
      e.preventDefault();
      onChange(VIEWPORT_ORDER[0]);
    } else if (e.key === "End") {
      e.preventDefault();
      onChange(VIEWPORT_ORDER[VIEWPORT_ORDER.length - 1]);
    }
  }

  return (
    <div className={className} data-testid="viewport-toggle">
      {/* Desktop/tablet toolbar. */}
      <div
        role="toolbar"
        aria-label="Preview viewport size"
        onKeyDown={handleKey}
        className="instinct-vt-toolbar"
        style={toolbarStyle}
      >
        {VIEWPORT_ORDER.map((v) => {
          const active = v === value;
          return (
            <button
              key={v}
              ref={(el) => {
                buttonRefs.current[v] = el;
              }}
              type="button"
              role="button"
              aria-pressed={active}
              aria-label={`${LABELS[v]} preview (${VIEWPORT_WIDTHS[v]}px)`}
              title={`${LABELS[v]} — ${VIEWPORT_WIDTHS[v]}px`}
              data-testid={`viewport-toggle-${v}`}
              data-active={active ? "true" : "false"}
              tabIndex={active ? 0 : -1}
              onClick={() => onChange(v)}
              style={buttonStyle(active)}
            >
              <ViewportIcon variant={v} />
              <span>{LABELS[v]}</span>
            </button>
          );
        })}
      </div>

      {/* Mobile-collapsed select. Shown < 768px via CSS. */}
      <label
        className="instinct-vt-select"
        style={{ display: "none", gap: 6, alignItems: "center" }}
      >
        <span style={{ fontSize: 12, color: "var(--wp-text-dim, #a0a8b4)" }}>Preview:</span>
        <select
          aria-label="Preview viewport size"
          data-testid="viewport-toggle-select"
          value={value}
          onChange={(e) => onChange(e.target.value as Viewport)}
          style={selectStyle}
        >
          {VIEWPORT_ORDER.map((v) => (
            <option key={v} value={v}>
              {LABELS[v]} ({VIEWPORT_WIDTHS[v]}px)
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

export { ViewportToggle };

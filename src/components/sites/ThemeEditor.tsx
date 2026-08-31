"use client";

/**
 * ThemeEditor — non-technical brand picker for a SiteBrief.
 *
 * Surfaces the 5 theme color slots (primary / accent / bg / fg / muted) as
 * paired text + native color inputs, plus a curated Google Font dropdown.
 * Every input has id + name + matching `<label htmlFor>` to satisfy the
 * 2026-04-18 a11y contract enforced by `brief-form-a11y.test.tsx`.
 *
 * Tolerant input model:
 *   - The text input accepts any string (so the user can type mid-edit
 *     without the field snapping back). Only valid `#rrggbb` hex values
 *     propagate to the parent via `onChange`. The server validator
 *     (sites-schema.ts) is the authoritative gate on persist.
 *   - Color <input type=color /> native picker always fires valid hex
 *     values — those propagate unconditionally.
 *
 * Analytics: every propagated change schedules a debounced
 * `site.theme_edited` POST to /api/analytics (500ms quiet window). Rapid
 * color-picker dragging doesn't flood the endpoint. Auth-gated 401 is
 * expected in logged-out previews and non-fatal — fire-and-forget.
 */

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { fetchWithRefresh, jsonHeaders } from "@/lib/client-auth";
import {
  CURATED_FONTS,
  DEFAULT_THEME,
  THEME_COLOR_KEYS,
  type CuratedFont,
  type SiteTheme,
  type ThemeColorKey,
  isValidHex,
} from "@/lib/site-theme";
import {
  DEFAULT_MOTION,
  DEFAULT_RADIUS,
  DEFAULT_SPACING,
  DEFAULT_TYPE_SCALE,
} from "@/lib/site-theme-tokens";
import type {
  MotionScale,
  RadiusScale,
  SpacingScale,
  TypeScale,
  TypeScaleEntry,
} from "@/lib/sites-schema";

// Token tier keys mirror the schema — declared here so collapsible sections
// can enumerate them in a stable order.
const SPACING_KEYS: (keyof SpacingScale)[] = ["xs", "sm", "md", "lg", "xl", "2xl"];
const RADIUS_KEYS: (keyof RadiusScale)[] = ["none", "sm", "md", "lg", "full"];
const TYPE_SCALE_TIERS: (keyof TypeScale)[] = [
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "display",
];

const COLOR_LABELS: Record<ThemeColorKey, string> = {
  primary: "Primary brand",
  accent: "Accent",
  bg: "Background",
  fg: "Foreground text",
  muted: "Muted / borders",
};

export interface ThemeEditorProps {
  value?: SiteTheme;
  onChange: (next: SiteTheme) => void;
  /**
   * Optional project id so debounced analytics can include it in
   * metadata. Parent (BriefForm or editor page) passes this when
   * available; undefined is fine — the event still fires.
   */
  projectId?: string;
}

const DEBOUNCE_MS = 500;

export function ThemeEditor({ value, onChange, projectId }: ThemeEditorProps) {
  // Resolve current theme vs. defaults once per render. We never mutate
  // `value` — always build a fresh object for `onChange`.
  const theme = value ?? {};
  const colors = theme.colors ?? {};
  const font = theme.font ?? {};

  // Debounced analytics. We accumulate which keys changed inside the
  // debounce window and POST the merged set once the user pauses. Empty
  // changed_keys would be a no-op, so we skip.
  const pendingKeysRef = useRef<Set<string>>(new Set());
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flushAnalytics = useCallback(() => {
    const keys = Array.from(pendingKeysRef.current);
    pendingKeysRef.current = new Set();
    timerRef.current = null;
    if (keys.length === 0) return;
    if (typeof window === "undefined") return;
    const metadata: Record<string, string | number | boolean> = {
      changed_keys: keys.join(","),
      changed_key_count: keys.length,
    };
    if (projectId) metadata.project_id = projectId;
    fetchWithRefresh("/api/analytics", {
      method: "POST",
      headers: jsonHeaders(),
      body: JSON.stringify({ event: "site.theme_edited", metadata }),
    }).catch(() => {
      /* analytics is best-effort — never block the editor */
    });
  }, [projectId]);

  const scheduleAnalytics = useCallback(
    (changedKey: string) => {
      pendingKeysRef.current.add(changedKey);
      if (timerRef.current !== null) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flushAnalytics, DEBOUNCE_MS);
    },
    [flushAnalytics],
  );

  // Per-edit analytics for design tokens (Path C Phase 1 · Stream P4).
  // Unlike theme_edited (debounced), token edits fire immediately so the
  // learning loop sees each discrete override. Fire-and-forget, never
  // blocks. projectId is promoted to `site_id` to align with the rest of
  // the sites.* event metadata.
  const trackTokenApplied = useCallback(
    (
      tokenGroup:
        | "spacing"
        | "radius"
        | "typeScale"
        | "motion"
        | "font",
      tokenName: string,
      newValue: string | number,
    ) => {
      if (typeof window === "undefined") return;
      const metadata: Record<string, string | number | boolean> = {
        token_group: tokenGroup,
        token_name: tokenName,
        new_value: String(newValue),
      };
      if (projectId) metadata.site_id = projectId;
      fetchWithRefresh("/api/analytics", {
        method: "POST",
        headers: jsonHeaders(),
        body: JSON.stringify({ event: "site.design_token_applied", metadata }),
      }).catch(() => {});
    },
    [projectId],
  );

  // Flush any pending event on unmount so we don't drop the last edit.
  useEffect(() => {
    return () => {
      if (timerRef.current !== null) {
        clearTimeout(timerRef.current);
        flushAnalytics();
      }
    };
  }, [flushAnalytics]);

  function updateColor(key: ThemeColorKey, hex: string) {
    // Only propagate valid hex — keeps the SiteTheme shape well-formed.
    // The text <input> still shows whatever the user is typing (state is
    // held by the input itself via `defaultValue`-free controlled value).
    if (!isValidHex(hex)) return;
    const nextColors = { ...colors, [key]: hex };
    onChange({ ...theme, colors: nextColors });
    scheduleAnalytics(`colors.${key}`);
  }

  function selectFont(fontId: string) {
    const picked = CURATED_FONTS.find((f) => f.id === fontId);
    if (!picked) return;
    const nextFont = {
      ...font,
      family: picked.family,
      googleFontName: picked.name,
    };
    onChange({ ...theme, font: nextFont });
    scheduleAnalytics("font.family");
  }

  // Token updaters — every one of these:
  //   1. builds a new partial scale (preserving other tiers),
  //   2. calls onChange with the new theme,
  //   3. fires an immediate `site.design_token_applied` analytics event.
  // Empty / whitespace-only values delete the tier so defaults win again.
  function updateSpacing(key: keyof SpacingScale, value: string) {
    const nextScale = { ...(theme.spacing ?? {}) };
    const trimmed = value.trim();
    if (trimmed === "") {
      delete nextScale[key];
    } else {
      nextScale[key] = trimmed;
    }
    onChange({ ...theme, spacing: nextScale });
    trackTokenApplied("spacing", String(key), trimmed || "(default)");
  }

  function updateRadius(key: keyof RadiusScale, value: string) {
    const nextScale = { ...(theme.radius ?? {}) };
    const trimmed = value.trim();
    if (trimmed === "") {
      delete nextScale[key];
    } else {
      nextScale[key] = trimmed;
    }
    onChange({ ...theme, radius: nextScale });
    trackTokenApplied("radius", String(key), trimmed || "(default)");
  }

  function updateTypeScale(
    tier: keyof TypeScale,
    field: "fontSize" | "lineHeight",
    value: string,
  ) {
    const nextScale: TypeScale = { ...(theme.typeScale ?? {}) };
    const existing: Partial<TypeScaleEntry> = { ...(nextScale[tier] ?? {}) };
    const trimmed = value.trim();
    if (trimmed === "") {
      delete (existing as Record<string, unknown>)[field];
    } else {
      (existing as Record<string, string>)[field] = trimmed;
    }
    // If both fields empty, remove the tier entirely so defaults win.
    if (!existing.fontSize && !existing.lineHeight) {
      delete nextScale[tier];
    } else if (existing.fontSize && existing.lineHeight) {
      nextScale[tier] = {
        fontSize: existing.fontSize,
        lineHeight: existing.lineHeight,
      };
    } else {
      // Partial — fill missing field from default so schema stays valid.
      nextScale[tier] = {
        fontSize: existing.fontSize ?? DEFAULT_TYPE_SCALE[tier].fontSize,
        lineHeight: existing.lineHeight ?? DEFAULT_TYPE_SCALE[tier].lineHeight,
      };
    }
    onChange({ ...theme, typeScale: nextScale });
    trackTokenApplied(
      "typeScale",
      `${String(tier)}.${field}`,
      trimmed || "(default)",
    );
  }

  // Which curated font (if any) matches the current selection? Match by
  // googleFontName first (exact), then by family string equality. If
  // neither matches we leave the dropdown on the "Custom" option.
  const activeFontId = findActiveFontId(font);

  const editorId = useId();

  return (
    <div data-theme-editor style={{ display: "grid", gap: "0.75rem" }}>
      <h3 style={{ margin: 0, fontSize: "1rem" }}>Brand theme</h3>
      <p style={{ margin: 0, fontSize: "0.75rem", color: "var(--wp-text-dim)" }}>
        Pick the colors and font that match your brand. Changes preview live;
        the deployed site picks these up on the next build.
      </p>

      <div
        data-theme-colors
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))",
          gap: "0.5rem",
        }}
      >
        {THEME_COLOR_KEYS.map((key) => {
          const current = colors[key] ?? DEFAULT_THEME.colors?.[key] ?? "#000000";
          const rowId = `${editorId}-color-${key}`;
          return (
            <div key={key} style={fieldBox()}>
              <label
                htmlFor={`${rowId}-hex`}
                style={labelStyle()}
              >
                {COLOR_LABELS[key]}
              </label>
              <div style={{ display: "flex", gap: "0.4rem", alignItems: "center" }}>
                <input
                  id={`${rowId}-swatch`}
                  name={`theme-${key}-swatch`}
                  type="color"
                  aria-label={`${COLOR_LABELS[key]} color swatch`}
                  value={isValidHex(current) ? current : "#000000"}
                  onChange={(e) => updateColor(key, e.target.value)}
                  style={{
                    width: "34px",
                    height: "34px",
                    padding: 0,
                    border: "1px solid var(--wp-border)",
                    borderRadius: "4px",
                    background: "transparent",
                    cursor: "pointer",
                  }}
                />
                <input
                  id={`${rowId}-hex`}
                  name={`theme-${key}-hex`}
                  type="text"
                  inputMode="text"
                  spellCheck={false}
                  placeholder="#112233"
                  aria-label={`${COLOR_LABELS[key]} hex value`}
                  defaultValue={current}
                  onChange={(e) => updateColor(key, e.target.value.trim())}
                  style={textInput()}
                />
              </div>
            </div>
          );
        })}
      </div>

      <div style={fieldBox()}>
        <label
          htmlFor={`${editorId}-font`}
          style={labelStyle()}
        >
          Font family
        </label>
        <select
          id={`${editorId}-font`}
          name="theme-font-family"
          value={activeFontId ?? ""}
          onChange={(e) => selectFont(e.target.value)}
          style={{ ...textInput(), cursor: "pointer" }}
        >
          {activeFontId === null ? (
            <option value="" disabled>
              Custom (select a font)
            </option>
          ) : null}
          {CURATED_FONTS.map((f) => (
            <option key={f.id} value={f.id}>
              {f.name} ({f.category})
            </option>
          ))}
        </select>
        <p style={{ margin: "0.25rem 0 0", fontSize: "0.7rem", color: "var(--wp-text-dim)" }}>
          {font.family ?? DEFAULT_THEME.font?.family}
        </p>
      </div>

      {/* -------------------- SPACING SCALE -------------------- */}
      <TokenSection
        title="Spacing scale"
        hint="Design-system spacing tokens — 4 / 8 / 16 / 24 / 32 / 48 px by default. Leave empty to use the default."
        testId="theme-spacing"
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "0.5rem",
          }}
        >
          {SPACING_KEYS.map((k) => {
            const id = `${editorId}-spacing-${k}`;
            const current = theme.spacing?.[k] ?? "";
            const placeholder = DEFAULT_SPACING[k];
            return (
              <div key={`spacing-${k}`} style={fieldBox()}>
                <label htmlFor={id} style={labelStyle()}>
                  Spacing {String(k)}
                </label>
                <input
                  id={id}
                  name={`theme-spacing-${String(k)}`}
                  type="text"
                  inputMode="text"
                  spellCheck={false}
                  data-token-group="spacing"
                  data-token-name={String(k)}
                  aria-label={`Spacing ${String(k)} token`}
                  placeholder={placeholder}
                  defaultValue={current}
                  onChange={(e) => updateSpacing(k, e.target.value)}
                  style={textInput()}
                />
              </div>
            );
          })}
        </div>
      </TokenSection>

      {/* -------------------- RADIUS SCALE --------------------- */}
      <TokenSection
        title="Border radius"
        hint="Corner rounding — 0 / 4 / 8 / 16 px, plus a fully-rounded pill token. Leave empty to use the default."
        testId="theme-radius"
      >
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(140px, 1fr))",
            gap: "0.5rem",
          }}
        >
          {RADIUS_KEYS.map((k) => {
            const id = `${editorId}-radius-${k}`;
            const current = theme.radius?.[k] ?? "";
            const placeholder = DEFAULT_RADIUS[k];
            return (
              <div key={`radius-${k}`} style={fieldBox()}>
                <label htmlFor={id} style={labelStyle()}>
                  Radius {String(k)}
                </label>
                <input
                  id={id}
                  name={`theme-radius-${String(k)}`}
                  type="text"
                  inputMode="text"
                  spellCheck={false}
                  data-token-group="radius"
                  data-token-name={String(k)}
                  aria-label={`Radius ${String(k)} token`}
                  placeholder={placeholder}
                  defaultValue={current}
                  onChange={(e) => updateRadius(k, e.target.value)}
                  style={textInput()}
                />
              </div>
            );
          })}
        </div>
      </TokenSection>

      {/* -------------------- TYPE SCALE ----------------------- */}
      <TokenSection
        title="Typography scale"
        hint="Font size + line height at each tier. Enter CSS dimensions (e.g. 16px, 1.5rem). Line-height accepts unitless ratios (1.4). Leave empty to use the default."
        testId="theme-typescale"
      >
        <div style={{ display: "grid", gap: "0.4rem" }}>
          {TYPE_SCALE_TIERS.map((tier) => {
            const tierStr = String(tier);
            const sizeId = `${editorId}-type-${tierStr}-size`;
            const lineId = `${editorId}-type-${tierStr}-line`;
            const entry = theme.typeScale?.[tier];
            const dflt = DEFAULT_TYPE_SCALE[tier];
            return (
              <div
                key={`type-${tierStr}`}
                style={{
                  ...fieldBox(),
                  display: "grid",
                  gridTemplateColumns: "90px 1fr 1fr",
                  gap: "0.4rem",
                  alignItems: "center",
                }}
              >
                <label
                  htmlFor={sizeId}
                  style={{ ...labelStyle(), marginBottom: 0 }}
                >
                  {tierStr}
                </label>
                <input
                  id={sizeId}
                  name={`theme-type-${tierStr}-fontSize`}
                  type="text"
                  inputMode="text"
                  spellCheck={false}
                  data-token-group="typeScale"
                  data-token-name={`${tierStr}.fontSize`}
                  aria-label={`Type ${tierStr} font size`}
                  placeholder={dflt.fontSize}
                  defaultValue={entry?.fontSize ?? ""}
                  onChange={(e) => updateTypeScale(tier, "fontSize", e.target.value)}
                  style={textInput()}
                />
                <input
                  id={lineId}
                  name={`theme-type-${tierStr}-lineHeight`}
                  type="text"
                  inputMode="text"
                  spellCheck={false}
                  data-token-group="typeScale"
                  data-token-name={`${tierStr}.lineHeight`}
                  aria-label={`Type ${tierStr} line height`}
                  placeholder={dflt.lineHeight}
                  defaultValue={entry?.lineHeight ?? ""}
                  onChange={(e) =>
                    updateTypeScale(tier, "lineHeight", e.target.value)
                  }
                  style={textInput()}
                />
              </div>
            );
          })}
        </div>
      </TokenSection>
    </div>
  );
}

// ---------------------------------------------------------------------------
// TokenSection — progressive-disclosure wrapper.
//
// Collapsed by default so existing users aren't overwhelmed by the new
// token UI on first load. Uses a native <details>/<summary> so the a11y
// contract is free: keyboard-openable, screen-reader announces expand
// state, no JS required for the core behavior. The summary carries a
// stable `data-testid` so RTL + Playwright can toggle it deterministically.
// ---------------------------------------------------------------------------
function TokenSection({
  title,
  hint,
  testId,
  children,
}: {
  title: string;
  hint: string;
  testId: string;
  children: React.ReactNode;
}) {
  // Track open state so tests can assert it directly via DOM attributes.
  const [open, setOpen] = useState(false);
  return (
    <details
      data-testid={testId}
      data-open={open ? "1" : "0"}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      style={{
        border: "1px solid var(--wp-border)",
        borderRadius: "6px",
        background: "var(--wp-card)",
        padding: "0.5rem 0.75rem",
      }}
    >
      <summary
        data-testid={`${testId}-summary`}
        style={{
          cursor: "pointer",
          fontSize: "0.85rem",
          fontWeight: 600,
          listStyle: "revert",
        }}
      >
        {title}
      </summary>
      <p
        style={{
          margin: "0.4rem 0 0.6rem",
          fontSize: "0.7rem",
          color: "var(--wp-text-dim)",
        }}
      >
        {hint}
      </p>
      {children}
    </details>
  );
}

function findActiveFontId(font: { family?: string; googleFontName?: string }): string | null {
  if (font.googleFontName) {
    const byName = CURATED_FONTS.find(
      (f) => f.name.toLowerCase() === font.googleFontName!.toLowerCase(),
    );
    if (byName) return byName.id;
  }
  if (font.family) {
    const byFamily = CURATED_FONTS.find((f) => f.family === font.family);
    if (byFamily) return byFamily.id;
  }
  return null;
}

function fieldBox(): React.CSSProperties {
  return {
    display: "block",
    padding: "0.5rem",
    background: "var(--wp-card)",
    border: "1px solid var(--wp-border)",
    borderRadius: "6px",
  };
}
function labelStyle(): React.CSSProperties {
  return {
    display: "block",
    fontSize: "0.7rem",
    color: "var(--wp-text-dim)",
    marginBottom: "0.25rem",
    textTransform: "uppercase",
    letterSpacing: "0.05em",
  };
}
function textInput(): React.CSSProperties {
  return {
    width: "100%",
    padding: "0.4rem 0.55rem",
    background: "var(--wp-dark)",
    border: "1px solid var(--wp-border)",
    borderRadius: "5px",
    color: "var(--wp-text)",
    fontSize: "0.8rem",
    fontFamily: "inherit",
  };
}

// Re-export SiteTheme here so callers can import it from the component
// module the same way they import Brief from BriefForm. Cuts back on
// deep imports into src/lib from sibling components.
export type { SiteTheme } from "@/lib/site-theme";

// Helper used by tests — returns the curated font by id.
export function __findCuratedFont(id: string): CuratedFont | undefined {
  return CURATED_FONTS.find((f) => f.id === id);
}

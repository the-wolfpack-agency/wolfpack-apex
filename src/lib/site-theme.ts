/**
 * Site theme helpers — pure, client-safe.
 *
 * The SiteBrief.theme field is Instinct's per-client brand layer: 5 brand
 * colors + a Google Font. This file exports:
 *
 *   - DEFAULT_THEME         Neutral starter used on new briefs.
 *   - CURATED_FONTS         12 Google Fonts (sans/serif/mono/display mix)
 *                           the non-technical team can pick from without
 *                           hitting a font-picker UI that queries Google
 *                           dynamically. Fallbacks baked into each family
 *                           string so the site never shows Times New Roman.
 *   - themeToCssVars(theme) Flat Record<string,string> of `--wp-site-*`
 *                           CSS variables. Undefined theme → {} (let the
 *                           section components' `var(...)` fallbacks win).
 *                           Partial theme → only the set keys; missing
 *                           fields are OMITTED, not zeroed.
 *   - hexToRgb(hex)         Parsing + validation. Returns null for
 *                           anything that isn't `#rrggbb`. Used for
 *                           contrast math in the editor preview.
 *
 * No `pg`, no `fetch`, no React — keep this file browser-safe so the
 * editor can import it without dragging server deps into the bundle.
 */
// Re-export the canonical SiteTheme type from the schema so there's one
// source of truth. Keeping the interface re-export here means callers
// can import `SiteTheme` alongside the helpers without a second import.
export type { SiteTheme, SiteThemeColors, SiteThemeFont } from "./sites-schema";
import type { SiteTheme } from "./sites-schema";

export interface CuratedFont {
  id: string;
  name: string;
  family: string;
  category: "sans" | "serif" | "mono" | "display";
}

/**
 * The five color slots every theme can override. Order matches the UI
 * grid: primary (brand), accent (secondary CTA), bg (page background),
 * fg (body text), muted (borders, dim copy).
 */
export const THEME_COLOR_KEYS = ["primary", "accent", "bg", "fg", "muted"] as const;
export type ThemeColorKey = (typeof THEME_COLOR_KEYS)[number];

/**
 * Neutral starter values. `#0b0b10` bg + `#f4f4f6` fg gives the dark-mode
 * look used by the Instinct dashboard. Clients can override any or all.
 */
export const DEFAULT_THEME: SiteTheme = {
  colors: {
    primary: "#d4af37",
    accent: "#6366f1",
    bg: "#0b0b10",
    fg: "#f4f4f6",
    muted: "#2a2a35",
  },
  font: {
    family: "'Inter', system-ui, -apple-system, sans-serif",
    googleFontName: "Inter",
  },
};

/**
 * Curated Google Fonts. Kept short so the dropdown fits on mobile; mix
 * of sans/serif/mono/display so dealers in any vertical find something.
 * Every family string ends with a generic fallback so stale <link> tags
 * never produce Times New Roman.
 */
export const CURATED_FONTS: CuratedFont[] = [
  { id: "inter", name: "Inter", family: "'Inter', system-ui, -apple-system, sans-serif", category: "sans" },
  { id: "roboto", name: "Roboto", family: "'Roboto', system-ui, sans-serif", category: "sans" },
  { id: "poppins", name: "Poppins", family: "'Poppins', system-ui, sans-serif", category: "sans" },
  { id: "work-sans", name: "Work Sans", family: "'Work Sans', system-ui, sans-serif", category: "sans" },
  { id: "dm-sans", name: "DM Sans", family: "'DM Sans', system-ui, sans-serif", category: "sans" },
  { id: "lora", name: "Lora", family: "'Lora', Georgia, serif", category: "serif" },
  { id: "merriweather", name: "Merriweather", family: "'Merriweather', Georgia, serif", category: "serif" },
  { id: "playfair-display", name: "Playfair Display", family: "'Playfair Display', Georgia, serif", category: "serif" },
  { id: "source-serif-pro", name: "Source Serif Pro", family: "'Source Serif Pro', Georgia, serif", category: "serif" },
  { id: "space-mono", name: "Space Mono", family: "'Space Mono', ui-monospace, monospace", category: "mono" },
  { id: "jetbrains-mono", name: "JetBrains Mono", family: "'JetBrains Mono', ui-monospace, monospace", category: "mono" },
  { id: "bebas-neue", name: "Bebas Neue", family: "'Bebas Neue', Impact, sans-serif", category: "display" },
];

const HEX_RE = /^#[0-9a-f]{6}$/i;

export function isValidHex(value: string | undefined): value is string {
  return typeof value === "string" && HEX_RE.test(value);
}

/**
 * Parse a `#rrggbb` hex string into its RGB components. Returns null for
 * anything malformed (short hex, alpha, non-hex chars). The editor uses
 * this for future contrast math against fg/bg pairs.
 */
export function hexToRgb(hex: string | undefined | null): { r: number; g: number; b: number } | null {
  if (!hex || typeof hex !== "string") return null;
  if (!HEX_RE.test(hex)) return null;
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return { r, g, b };
}

/**
 * Flatten a theme into CSS custom properties. Keys:
 *   --wp-site-primary / --wp-site-accent / --wp-site-bg / --wp-site-fg
 *   / --wp-site-muted / --wp-site-font-family
 *
 * Unset keys are OMITTED rather than set to empty-string. The section
 * components all use `var(--wp-site-primary, <fallback>)` so an absent
 * variable cleanly falls back to the Instinct default palette.
 */
export function themeToCssVars(theme?: SiteTheme): Record<string, string> {
  const out: Record<string, string> = {};
  if (!theme || typeof theme !== "object") return out;
  const colors = theme.colors ?? {};
  for (const key of THEME_COLOR_KEYS) {
    const v = colors[key];
    if (isValidHex(v)) {
      out[`--wp-site-${key}`] = v;
    }
  }
  const family = theme.font?.family;
  if (typeof family === "string" && family.trim().length > 0) {
    out["--wp-site-font-family"] = family;
  }
  return out;
}

/**
 * Coerce a theme-shaped value out of the legacy `Record<string,string>`
 * shape. Older briefs stored `theme = {primary: "#x", font: "Inter"}` as
 * a flat map; newer code uses the nested shape. This helper accepts both
 * and normalizes to SiteTheme so the editor never sees the flat form.
 * Unknown keys are dropped.
 */
export function normalizeTheme(raw: unknown): SiteTheme | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  // Already nested shape.
  if (r.colors && typeof r.colors === "object") {
    return raw as SiteTheme;
  }
  // Flat legacy form — lift known keys into the nested shape.
  const theme: SiteTheme = { colors: {} };
  for (const k of THEME_COLOR_KEYS) {
    const v = r[k];
    if (isValidHex(typeof v === "string" ? v : undefined)) {
      theme.colors![k] = v as string;
    }
  }
  if (typeof r.font === "string" && r.font.trim().length > 0) {
    theme.font = { family: r.font };
  }
  return theme;
}

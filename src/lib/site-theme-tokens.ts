/**
 * site-theme-tokens — design-token scale defaults + resolution + CSS-var
 * emission. Pure, browser-safe (zero pg/fetch/React). Consumed by:
 *
 *   - ThemeEditor.tsx — reads defaults to show placeholders when a field
 *     is empty, so the designer sees "what default means."
 *   - render-brief.tsx — resolves partial theme against defaults and
 *     injects the full CSS-var set, so section renderers can consume
 *     `var(--wp-space-md)` / `var(--wp-radius-md)` / `var(--wp-type-base-size)`
 *     without a build step.
 *   - wolfpack-site-template — the same CSS-var output format is shipped
 *     to the template head on deploy; the template's global styles read
 *     `var(--wp-*, <fallback>)` so the deployed site and the internal
 *     preview render identically.
 *
 * Default scale choices are aligned with modern design systems (Tailwind,
 * Apple HIG, Material 3): 4/8/16/24/32/48 px spacing, 0/4/8/16/9999 px
 * radii, 12..60 px type scale, 150/250/400 ms motion with the standard
 * Material cubic-bezier(0.4, 0, 0.2, 1) ease. Designers edit any field;
 * every unset field falls back here.
 *
 * Learning-loop note: the delta between a defaulted token and an edited
 * token is the signal we care about. `themeTokensToCssVars` emits every
 * resolved key, so downstream analytics can compare brief.theme.spacing
 * (what the designer set) against DEFAULT_SPACING (what they didn't).
 * Over time, the brain distills per-client "brand tokens" from that
 * delta.
 */

import type {
  FontStack,
  MotionScale,
  RadiusScale,
  SiteTheme,
  SiteThemeColors,
  SpacingScale,
  TypeScale,
} from "./sites-schema";
import { normalizeFont } from "./sites-schema";
import { DEFAULT_THEME } from "./site-theme";

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

/**
 * Spacing scale — 4/8/16/24/32/48 px. Consistent with the 4px base grid
 * Tailwind + Material use. Designers override per brand.
 */
export const DEFAULT_SPACING: Required<SpacingScale> = {
  xs: "4px",
  sm: "8px",
  md: "16px",
  lg: "24px",
  xl: "32px",
  "2xl": "48px",
};

/**
 * Radius scale — 0 / 4 / 8 / 16 px + a fully-rounded `full` token (9999px)
 * used for pills and avatar crops. Keeps the visual language coherent
 * between buttons (sm), cards (md), and feature blocks (lg).
 */
export const DEFAULT_RADIUS: Required<RadiusScale> = {
  none: "0",
  sm: "4px",
  md: "8px",
  lg: "16px",
  full: "9999px",
};

/**
 * Type scale — 12/16 .. 60/72. Each tier is { fontSize, lineHeight }. The
 * lineHeight is a CSS dimension (not a unitless ratio) so we can emit the
 * pair into a single CSS var pair without runtime math.
 */
export const DEFAULT_TYPE_SCALE: Required<TypeScale> = {
  xs: { fontSize: "12px", lineHeight: "16px" },
  sm: { fontSize: "14px", lineHeight: "20px" },
  base: { fontSize: "16px", lineHeight: "24px" },
  lg: { fontSize: "18px", lineHeight: "28px" },
  xl: { fontSize: "20px", lineHeight: "30px" },
  "2xl": { fontSize: "24px", lineHeight: "32px" },
  "3xl": { fontSize: "30px", lineHeight: "40px" },
  "4xl": { fontSize: "36px", lineHeight: "48px" },
  display: { fontSize: "60px", lineHeight: "72px" },
};

/**
 * Motion scale — fast/normal/slow + a Material-style standard ease. These
 * map to CSS `transition-duration` and `transition-timing-function`.
 */
export const DEFAULT_MOTION: Required<MotionScale> = {
  fast: "150ms",
  normal: "250ms",
  slow: "400ms",
  ease: "cubic-bezier(0.4, 0, 0.2, 1)",
};

/**
 * Default font weights baked into the font stack. Designers can widen or
 * narrow the range (e.g. a display brand that ships only 400/900).
 */
export const DEFAULT_FONT_STACK: Required<FontStack> = {
  family: DEFAULT_THEME.font?.family ?? "'Inter', system-ui, -apple-system, sans-serif",
  googleFontName: DEFAULT_THEME.font?.googleFontName ?? "Inter",
  weightRegular: 400,
  weightMedium: 500,
  weightBold: 700,
  bodyFamily:
    DEFAULT_THEME.font?.family ?? "'Inter', system-ui, -apple-system, sans-serif",
};

/**
 * Default colors mirror `DEFAULT_THEME.colors` from site-theme.ts. We
 * re-export them as a `Required<SiteThemeColors>` so the resolver can
 * promise every field is populated.
 */
export const DEFAULT_COLORS: Required<SiteThemeColors> = {
  primary: DEFAULT_THEME.colors?.primary ?? "#d4af37",
  accent: DEFAULT_THEME.colors?.accent ?? "#6366f1",
  bg: DEFAULT_THEME.colors?.bg ?? "#0b0b10",
  fg: DEFAULT_THEME.colors?.fg ?? "#f4f4f6",
  muted: DEFAULT_THEME.colors?.muted ?? "#2a2a35",
};

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * ResolvedTheme — every design-token field guaranteed populated. Never
 * presented to the user; strictly the shape consumed by the renderer +
 * the CSS-var emitter. Keeps downstream code from having to `??` every
 * token lookup.
 */
export interface ResolvedTheme {
  colors: Required<SiteThemeColors>;
  font: Required<FontStack>;
  spacing: Required<SpacingScale>;
  radius: Required<RadiusScale>;
  typeScale: Required<TypeScale>;
  motion: Required<MotionScale>;
}

/**
 * Merge a partial theme against the defaults. Any field the designer has
 * NOT edited falls through to the default; edited fields win. Returns a
 * fully-populated ResolvedTheme so callers can skip fallback handling.
 *
 * `typeScale` is merged per-entry (per tier), and per-entry fields are
 * also merged (edited fontSize without lineHeight picks up the default
 * lineHeight). Same for `font` — weights default if missing.
 */
export function resolveThemeTokens(theme: SiteTheme | undefined): ResolvedTheme {
  const t = theme ?? {};
  const fontIn = normalizeFont(t.font);

  return {
    colors: {
      ...DEFAULT_COLORS,
      ...(t.colors ?? {}),
    },
    font: {
      ...DEFAULT_FONT_STACK,
      ...fontIn,
    } as Required<FontStack>,
    spacing: {
      ...DEFAULT_SPACING,
      ...(t.spacing ?? {}),
    } as Required<SpacingScale>,
    radius: {
      ...DEFAULT_RADIUS,
      ...(t.radius ?? {}),
    } as Required<RadiusScale>,
    typeScale: mergeTypeScale(t.typeScale),
    motion: {
      ...DEFAULT_MOTION,
      ...(t.motion ?? {}),
    } as Required<MotionScale>,
  };
}

function mergeTypeScale(partial: TypeScale | undefined): Required<TypeScale> {
  const out = { ...DEFAULT_TYPE_SCALE } as Required<TypeScale>;
  if (!partial) return out;
  const keys = Object.keys(DEFAULT_TYPE_SCALE) as (keyof TypeScale)[];
  for (const k of keys) {
    const edited = partial[k];
    if (!edited) continue;
    out[k] = {
      fontSize: edited.fontSize ?? DEFAULT_TYPE_SCALE[k].fontSize,
      lineHeight: edited.lineHeight ?? DEFAULT_TYPE_SCALE[k].lineHeight,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// CSS variable emission
// ---------------------------------------------------------------------------

/**
 * Convert a ResolvedTheme into a flat `:root`-style CSS string. Every
 * token gets exactly one `--wp-*` custom property. The naming convention:
 *
 *   Colors          --wp-site-<slot>          (shared with themeToCssVars)
 *   Font            --wp-site-font-family     (shared)
 *                   --wp-font-body
 *                   --wp-font-weight-<role>
 *   Spacing         --wp-space-<tier>
 *   Radius          --wp-radius-<tier>
 *   Type scale      --wp-type-<tier>-size
 *                   --wp-type-<tier>-line
 *   Motion          --wp-motion-<tier>
 *                   --wp-motion-ease
 *
 * Section renderers read via `var(--wp-space-md, 16px)` so a brief that
 * omits a token still renders correctly when the var isn't emitted (e.g.
 * bailout path). Callers that want the exact :root{...} wrapper can wrap
 * the returned string themselves. We return just the declarations so the
 * caller can inject into either a `<style>` tag OR as an inline style.
 */
export function themeTokensToCssVars(resolved: ResolvedTheme): string {
  const decls: string[] = [];

  // Colors + font family first — alignment with existing themeToCssVars
  // (site-theme.ts) keeps the existing section CSS untouched.
  for (const [slot, value] of Object.entries(resolved.colors)) {
    decls.push(`--wp-site-${slot}: ${value};`);
  }
  decls.push(`--wp-site-font-family: ${resolved.font.family};`);
  decls.push(`--wp-font-body: ${resolved.font.bodyFamily};`);
  decls.push(`--wp-font-weight-regular: ${resolved.font.weightRegular};`);
  decls.push(`--wp-font-weight-medium: ${resolved.font.weightMedium};`);
  decls.push(`--wp-font-weight-bold: ${resolved.font.weightBold};`);

  for (const [tier, value] of Object.entries(resolved.spacing)) {
    decls.push(`--wp-space-${tier}: ${value};`);
  }
  for (const [tier, value] of Object.entries(resolved.radius)) {
    decls.push(`--wp-radius-${tier}: ${value};`);
  }
  for (const [tier, entry] of Object.entries(resolved.typeScale)) {
    decls.push(`--wp-type-${tier}-size: ${entry.fontSize};`);
    decls.push(`--wp-type-${tier}-line: ${entry.lineHeight};`);
  }
  decls.push(`--wp-motion-fast: ${resolved.motion.fast};`);
  decls.push(`--wp-motion-normal: ${resolved.motion.normal};`);
  decls.push(`--wp-motion-slow: ${resolved.motion.slow};`);
  decls.push(`--wp-motion-ease: ${resolved.motion.ease};`);

  return decls.join(" ");
}

/**
 * Same as `themeTokensToCssVars` but returned as an object so React can
 * consume it via the `style` prop without a `<style>` tag. Keys are the
 * same `--wp-*` names; values are the same strings. Numeric weights are
 * coerced to strings because React treats unknown CSS-var values as raw
 * strings anyway.
 */
export function themeTokensToCssVarObject(
  resolved: ResolvedTheme,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [slot, value] of Object.entries(resolved.colors)) {
    out[`--wp-site-${slot}`] = value;
  }
  out["--wp-site-font-family"] = resolved.font.family;
  out["--wp-font-body"] = resolved.font.bodyFamily;
  out["--wp-font-weight-regular"] = String(resolved.font.weightRegular);
  out["--wp-font-weight-medium"] = String(resolved.font.weightMedium);
  out["--wp-font-weight-bold"] = String(resolved.font.weightBold);
  for (const [tier, value] of Object.entries(resolved.spacing)) {
    out[`--wp-space-${tier}`] = value;
  }
  for (const [tier, value] of Object.entries(resolved.radius)) {
    out[`--wp-radius-${tier}`] = value;
  }
  for (const [tier, entry] of Object.entries(resolved.typeScale)) {
    out[`--wp-type-${tier}-size`] = entry.fontSize;
    out[`--wp-type-${tier}-line`] = entry.lineHeight;
  }
  out["--wp-motion-fast"] = resolved.motion.fast;
  out["--wp-motion-normal"] = resolved.motion.normal;
  out["--wp-motion-slow"] = resolved.motion.slow;
  out["--wp-motion-ease"] = resolved.motion.ease;
  return out;
}

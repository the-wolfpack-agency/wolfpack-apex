/**
 * Public-responder theming (client branding).
 *
 * The responder renders every color through `var(--wp-*, fallback)`, so a
 * theme is just a set of those custom properties applied on an ancestor —
 * tokens-first, no per-component theming. `default` (null) keeps the
 * Instinct dark/gold fallbacks; `porsche` is the white-canvas + Guards Red
 * + Porsche Next skin measured from the Porsche Design System (matches
 * wolfpack-weekend's `.theme-porsche` tokens).
 */
import type { CSSProperties } from "react";

/** Porsche Next, served from the Porsche Design System CDN (same as the
 *  Porsche site). Injected only on the porsche theme. */
export const PORSCHE_FONT_FACE = `
@font-face{font-family:"Porsche Next";font-style:normal;font-weight:400;font-display:swap;src:url("https://cdn.ui.porsche.com/porsche-design-system/fonts/porsche-next-latin-regular.b8f1c20.woff2") format("woff2");}
@font-face{font-family:"Porsche Next";font-style:normal;font-weight:600;font-display:swap;src:url("https://cdn.ui.porsche.com/porsche-design-system/fonts/porsche-next-latin-semi-bold.b5f6fca.woff2") format("woff2");}
`;

/**
 * The `--wp-*` custom properties + base font for a survey theme. Spread onto
 * the responder's page-shell wrapper; the form re-skins automatically.
 */
export function surveyThemeVars(theme: string | null | undefined): CSSProperties {
  if (theme === "porsche") {
    return {
      // Guards Red accent, white canvas, near-black ink (#010205), tight feel.
      "--wp-dark": "#f4f4f6",
      "--wp-dark-surface": "#ffffff",
      "--wp-dark-border": "rgba(1,2,5,0.14)",
      "--wp-text": "#010205",
      "--wp-text-dim": "#6b6d70",
      "--wp-text-muted": "#6b6d70",
      "--wp-gold": "#d5001c",
      "--wp-error": "#d5001c",
      "--wp-accent-fg": "#ffffff",
      fontFamily: '"Porsche Next", "Arial Narrow", Arial, sans-serif',
      letterSpacing: "-0.01em",
    } as CSSProperties;
  }
  // Default: let the component's built-in fallbacks (Instinct dark/gold) apply.
  return {};
}

/** Whether a theme needs its web font injected. */
export function themeFontFace(theme: string | null | undefined): string | null {
  return theme === "porsche" ? PORSCHE_FONT_FACE : null;
}

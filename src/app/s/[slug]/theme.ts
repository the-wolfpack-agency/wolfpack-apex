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
  const PORSCHE_FONT = '"Porsche Next", "Arial Narrow", Arial, sans-serif';
  if (theme === "porsche") {
    return {
      // porsche.com: Guards Red accent, white canvas, near-black ink.
      "--wp-dark": "#f4f4f6",
      "--wp-dark-surface": "#ffffff",
      "--wp-dark-border": "rgba(1,2,5,0.14)",
      "--wp-text": "#010205",
      "--wp-text-dim": "#6b6d70",
      "--wp-text-muted": "#6b6d70",
      "--wp-gold": "#d5001c",
      "--wp-error": "#d5001c",
      "--wp-accent-fg": "#ffffff",
      fontFamily: PORSCHE_FONT,
      letterSpacing: "-0.01em",
    } as CSSProperties;
  }
  if (theme === "porsche-sage") {
    return {
      // "A Weekend with Porsche" pitch deck: near-black green-tinted canvas,
      // sage-green accent panels, white text, Porsche Next.
      "--wp-dark": "#0e1413",
      "--wp-dark-surface": "#19211f",
      "--wp-dark-border": "rgba(255,255,255,0.12)",
      "--wp-text": "#f2f4f3",
      "--wp-text-dim": "#b6c1bd",
      "--wp-text-muted": "#8c9893",
      "--wp-gold": "#7d958d", // deck sage accent (headings, buttons, rating)
      "--wp-error": "#e0746a",
      "--wp-accent-fg": "#0e1413", // dark ink on the light sage buttons
      fontFamily: PORSCHE_FONT,
      letterSpacing: "-0.01em",
    } as CSSProperties;
  }
  // Default: let the component's built-in fallbacks (Instinct dark/gold) apply.
  return {};
}

/** Themes that use the Porsche brand typeface + wordmark. */
export function isPorscheTheme(theme: string | null | undefined): boolean {
  return typeof theme === "string" && theme.startsWith("porsche");
}

/** Whether a theme needs its web font injected. */
export function themeFontFace(theme: string | null | undefined): string | null {
  return isPorscheTheme(theme) ? PORSCHE_FONT_FACE : null;
}

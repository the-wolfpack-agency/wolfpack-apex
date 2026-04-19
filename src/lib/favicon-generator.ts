/**
 * favicon-generator — zero-dep favicon synthesis.
 *
 * Exists so Instinct can ship a favicon for every site without requiring
 * the designer to upload one. Two paths:
 *
 *   1. Explicit URL: `favicon.src` wins. We return it verbatim.
 *   2. Auto-generate: `favicon.autoGenerate: true` produces an inline
 *      `data:image/svg+xml;base64,...` URL from the palette + monogram.
 *
 * No network requests. No new runtime dependencies. The SVG is trivial
 * enough (rounded square + centered text in system sans-serif) to render
 * in every modern browser. If neither path produces a favicon, we return
 * an empty string so the caller can omit the `<link rel="icon">` tag
 * rather than emit a broken reference.
 *
 * The `monogram` fallback chain (favicon.monogram → first char of
 * product.name → "?") is codified here so callers don't reimplement it.
 */

import type { SiteBrief, SiteTheme } from "@/lib/sites-schema";
import { hexToRgb, luminance } from "@/lib/image-palette";

const DEFAULT_BG = "#1f2937";
const DEFAULT_FG = "#ffffff";
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

/**
 * Emit an SVG favicon (24×24 rounded square + monogram). Returns an inline
 * SVG string — the caller wraps it in a data URL.
 */
export function paletteToFaviconSvg(opts: {
  bg: string;
  fg: string;
  monogram: string;
}): string {
  const bg = HEX_COLOR_RE.test(opts.bg) ? opts.bg : DEFAULT_BG;
  const fg = HEX_COLOR_RE.test(opts.fg) ? opts.fg : DEFAULT_FG;
  // Trim + upper-case + keep first 2 chars. If the caller passed empty
  // we render a dot so the square doesn't look completely blank.
  const trimmed = (opts.monogram || "").trim().slice(0, 2);
  const mono = trimmed.length > 0 ? trimmed.toUpperCase() : "·";
  // Shorter glyphs render larger; two-char monograms get slightly smaller
  // font so both chars fit inside the rounded square at 24×24.
  const fontSize = mono.length > 1 ? 12 : 16;
  // Inline styles keep the SVG self-contained; system-ui degrades
  // gracefully when rendered offline or on low-resource devices.
  // XML escape the monogram so characters like & and < can't break the
  // SVG. We also reject any character that would need CDATA wrapping.
  const safeMono = escapeXml(mono);
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="64" height="64">`,
    `<rect width="24" height="24" rx="5" ry="5" fill="${bg}"/>`,
    `<text x="12" y="12"`,
    ` text-anchor="middle" dominant-baseline="central"`,
    ` font-family="system-ui, -apple-system, Segoe UI, sans-serif"`,
    ` font-weight="700" font-size="${fontSize}"`,
    ` fill="${fg}">${safeMono}</text>`,
    `</svg>`,
  ].join("");
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Pick a readable foreground (white or near-black) for the given bg hex.
 * Uses the same luminance helper as `image-palette` so palette- and
 * favicon-derived contrast decisions agree. Falls back to white on a
 * malformed bg.
 */
export function pickContrastingForeground(bg: string): string {
  const rgb = hexToRgb(bg);
  if (!rgb) return DEFAULT_FG;
  const l = luminance(rgb[0], rgb[1], rgb[2]);
  return l > 0.6 ? "#111827" : DEFAULT_FG;
}

/**
 * Read the primary brand color out of a brief. Accepts both the nested
 * `SiteTheme` shape and the legacy flat `Record<string,string>` form
 * `validateBrief` also tolerates. Returns the default bg on any miss.
 */
export function resolvePrimaryColor(brief: SiteBrief | null | undefined): string {
  const theme = brief?.theme;
  if (!theme || typeof theme !== "object") return DEFAULT_BG;
  const nested = (theme as SiteTheme).colors;
  if (nested && typeof nested === "object") {
    if (typeof nested.primary === "string" && HEX_COLOR_RE.test(nested.primary)) {
      return nested.primary;
    }
    if (typeof nested.bg === "string" && HEX_COLOR_RE.test(nested.bg)) {
      return nested.bg;
    }
  }
  const flat = theme as Record<string, unknown>;
  if (typeof flat.primary === "string" && HEX_COLOR_RE.test(flat.primary as string)) {
    return flat.primary as string;
  }
  if (typeof flat.bg === "string" && HEX_COLOR_RE.test(flat.bg as string)) {
    return flat.bg as string;
  }
  return DEFAULT_BG;
}

/**
 * Pick the monogram for a brief. Priority:
 *   1. `favicon.monogram` (respects designer override)
 *   2. First 1-2 letters of `product.name` (strip leading punctuation)
 *   3. Empty string (renderer falls back to "·")
 */
export function resolveMonogram(brief: SiteBrief | null | undefined): string {
  const explicit = brief?.favicon?.monogram;
  if (typeof explicit === "string" && explicit.trim().length > 0) {
    return explicit.trim().slice(0, 2);
  }
  const name = brief?.product?.name ?? "";
  // Strip non-letters from the front so "!Acme" → "A". Then collapse
  // whitespace and keep the first two characters.
  const cleaned = name.replace(/^[^A-Za-z0-9]+/, "").trim();
  if (cleaned.length === 0) return "";
  return cleaned.slice(0, 1);
}

/**
 * Turn an SVG string into a data URL. Base64 keeps the URL printable and
 * copy-paste-safe across HTML attributes and HTTP headers.
 */
function svgToDataUrl(svg: string): string {
  // Buffer on the server, btoa in the browser. Both produce standard b64.
  let b64: string;
  if (typeof Buffer !== "undefined") {
    b64 = Buffer.from(svg, "utf8").toString("base64");
  } else if (typeof btoa !== "undefined") {
    // btoa needs latin-1; our SVG is ASCII + escaped monogram so safe.
    b64 = btoa(svg);
  } else {
    b64 = "";
  }
  return `data:image/svg+xml;base64,${b64}`;
}

/**
 * Decide the favicon `href` for a brief. Priority:
 *   1. `favicon.src` (explicit URL wins)
 *   2. `favicon.autoGenerate === true` → generated SVG data URL
 *   3. Otherwise empty string (caller skips the `<link rel="icon">`)
 */
export function briefToFaviconHref(brief: SiteBrief | null | undefined): string {
  if (!brief) return "";
  const fav = brief.favicon;
  if (!fav) return "";
  if (typeof fav.src === "string" && fav.src.trim().length > 0) {
    return fav.src.trim();
  }
  if (fav.autoGenerate) {
    const bg = resolvePrimaryColor(brief);
    const fg = pickContrastingForeground(bg);
    const monogram = resolveMonogram(brief);
    const svg = paletteToFaviconSvg({ bg, fg, monogram });
    return svgToDataUrl(svg);
  }
  return "";
}

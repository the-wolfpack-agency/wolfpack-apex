/**
 * Sites brief schema — CLIENT-SAFE subset of sites.ts.
 *
 * Exists so client components (the live preview iframe, the brief-edit
 * form) can `validateBrief` without pulling in `pg`, `trackEvent`, or
 * anything else that breaks the browser bundle. The server-side
 * `sites.ts` module re-exports these symbols so existing server imports
 * keep working unchanged.
 *
 * Do NOT import from "@/lib/db" or "@/lib/analytics" in this file.
 * Keep it pure types + validation. The Vercel client bundler's refusal
 * to resolve `tls`/`net` is the invariant this file defends.
 */

/* ----------------------------- Types ---------------------------------- */

export const SUPPORTED_SECTION_TYPES = [
  "hero",
  "text",
  "cards",
  "callout",
  "banner",
  "stats",
  "gallery",
  "quote",
  "video",
  "testimonial",
  "pricing",
  "faq",
] as const;
export type SectionType = (typeof SUPPORTED_SECTION_TYPES)[number];

export type VideoProvider = "youtube" | "vimeo";

export interface BriefSection {
  type: SectionType;
  heading?: string;
  body?: string;
  cta?: { label: string; href: string };
  backgroundImage?: string;
  height?: string;
  // items[] is a widened union covering every section that uses it
  // (cards/stats/testimonial/pricing/faq). Each renderer narrows on the
  // fields it needs; validateBrief enforces per-type invariants. Widening
  // here instead of splintering into per-type section interfaces keeps
  // the existing BriefForm/test import surface stable.
  items?: Array<{
    // cards / stats
    title?: string;
    body?: string;
    accent?: boolean;
    badge?: string;
    label?: string;
    value?: number;
    prefix?: string;
    suffix?: string;
    // testimonial
    quote?: string;
    authorName?: string;
    authorTitle?: string;
    authorPhotoUrl?: string;
    // pricing
    name?: string;
    price?: string;
    features?: string[];
    cta?: { label: string; href: string };
    highlighted?: boolean;
    // faq
    question?: string;
    answer?: string;
  }>;
  images?: Array<{ src: string; alt?: string } | string>;
  attribution?: string;
  // Video section fields — populated only when `type === "video"`.
  // Inferred provider (`youtube` | `vimeo`) is optional; the renderer
  // derives it from the URL host when omitted. All fields validated in
  // `validateBrief` below.
  videoUrl?: string;
  provider?: VideoProvider;
  autoplay?: boolean;
  startSeconds?: number;
}

export interface BriefPage {
  route: string;
  title?: string;
  sections: BriefSection[];
}

/**
 * Per-client brand layer. `theme` was originally a loose
 * `Record<string, string>` — no field was set, no code read it. The
 * ThemeEditor (2026-04-17) gave it a typed shape, but existing DB rows
 * may still carry the flat form. The validator below accepts BOTH:
 *   - nested: `{ colors: { primary: "#..." }, font: { family: "..." } }`
 *   - flat legacy: `{ primary: "#...", font: "Inter", ... }`
 * Consumers should normalize via `normalizeTheme` in site-theme.ts
 * before reading.
 */
export interface SiteThemeColors {
  primary?: string;
  accent?: string;
  bg?: string;
  fg?: string;
  muted?: string;
}
export interface SiteThemeFont {
  family?: string;
  googleFontName?: string;
}
export interface SiteTheme {
  colors?: SiteThemeColors;
  font?: SiteThemeFont;
}

export interface SiteBrief {
  client: string;
  product: {
    name: string;
    tagline?: string;
    domain?: string;
    supportEmail?: string;
  };
  /**
   * Optional brand theme. Accepts the nested SiteTheme shape OR the
   * legacy flat `Record<string,string>` form for back-compat. Use
   * `normalizeTheme` from `site-theme.ts` to coerce to SiteTheme.
   */
  theme?: SiteTheme | Record<string, string>;
  pages: BriefPage[];
  contactForm?: { fields: string[] };
}

export type SiteStatus = "draft" | "provisioning" | "deploying" | "ready" | "failed";

/* ----------------------------- Validation ----------------------------- */

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const THEME_COLOR_FIELDS = ["primary", "accent", "bg", "fg", "muted"] as const;

export class BriefValidationError extends Error {
  constructor(public errors: string[]) {
    super(`brief invalid:\n  - ${errors.join("\n  - ")}`);
    this.name = "BriefValidationError";
  }
}

/**
 * Strict brief validation. Mirrors the wolfpack-site-template scaffolder
 * one-to-one so anything we accept is guaranteed to render there.
 * Throws BriefValidationError on any failure.
 */
export function validateBrief(brief: unknown): asserts brief is SiteBrief {
  const errors: string[] = [];
  const b = brief as Partial<SiteBrief> | null;

  if (!b || typeof b !== "object") {
    throw new BriefValidationError(["brief must be an object"]);
  }
  if (!b.client || typeof b.client !== "string" || !SLUG_RE.test(b.client)) {
    errors.push("client must be a lowercase slug (a-z, 0-9, -; 2-39 chars)");
  }
  if (!b.product?.name || typeof b.product.name !== "string") {
    errors.push("product.name required");
  }
  if (b.product?.supportEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.product.supportEmail)) {
    errors.push("product.supportEmail must be a valid email");
  }
  if (!Array.isArray(b.pages) || b.pages.length === 0) {
    errors.push("pages array required (at least one page)");
  }
  // Theme is optional. If present, it must be an object; we accept both
  // the nested SiteTheme shape and the legacy flat Record<string,string>
  // form. For the nested shape, validate hex colors + font.family
  // length. For the flat legacy form we only lightly validate the known
  // color keys (so old briefs parse without error).
  if (b.theme !== undefined) {
    if (!b.theme || typeof b.theme !== "object" || Array.isArray(b.theme)) {
      errors.push("theme must be an object");
    } else {
      const t = b.theme as Record<string, unknown>;
      const nestedColors = t.colors as Record<string, unknown> | undefined;
      if (nestedColors !== undefined) {
        if (typeof nestedColors !== "object" || nestedColors === null || Array.isArray(nestedColors)) {
          errors.push("theme.colors must be an object");
        } else {
          for (const key of THEME_COLOR_FIELDS) {
            const v = nestedColors[key];
            if (v !== undefined && (typeof v !== "string" || !HEX_COLOR_RE.test(v))) {
              errors.push(`theme.colors.${key} must be a hex color like #112233`);
            }
          }
        }
      } else {
        // Flat legacy form — validate any known color keys present at top level.
        for (const key of THEME_COLOR_FIELDS) {
          const v = t[key];
          if (v !== undefined && (typeof v !== "string" || !HEX_COLOR_RE.test(v))) {
            errors.push(`theme.${key} must be a hex color like #112233`);
          }
        }
      }
      const nestedFont = t.font;
      if (nestedFont !== undefined && typeof nestedFont === "object" && nestedFont !== null && !Array.isArray(nestedFont)) {
        const f = nestedFont as Record<string, unknown>;
        if (f.family !== undefined) {
          if (typeof f.family !== "string" || f.family.length > 100) {
            errors.push("theme.font.family must be a string of at most 100 chars");
          }
        }
        if (f.googleFontName !== undefined && typeof f.googleFontName !== "string") {
          errors.push("theme.font.googleFontName must be a string");
        }
      } else if (typeof nestedFont === "string") {
        // Legacy flat form: `font: "Inter"` — accept it, just enforce length.
        if (nestedFont.length > 100) {
          errors.push("theme.font must be a string of at most 100 chars");
        }
      } else if (nestedFont !== undefined) {
        errors.push("theme.font must be an object or string");
      }
    }
  }
  const known = new Set<string>(SUPPORTED_SECTION_TYPES);
  for (const p of b.pages || []) {
    if (!p.route?.startsWith("/")) errors.push(`page.route must start with / (got ${p.route})`);
    if (!Array.isArray(p.sections)) {
      errors.push(`page ${p.route}: sections array required`);
      continue;
    }
    for (const s of p.sections) {
      if (!known.has(s.type)) {
        errors.push(`page ${p.route}: unknown section type "${s.type}"`);
      }
      if (s.type === "stats") {
        for (const it of s.items || []) {
          if (typeof it.value !== "number") {
            errors.push(`page ${p.route}: stats.items[].value must be a number`);
          }
        }
      }
      if (s.type === "gallery" && !Array.isArray(s.images)) {
        errors.push(`page ${p.route}: gallery.images array required`);
      }
      if (s.type === "video") {
        if (typeof s.videoUrl !== "string" || !s.videoUrl.startsWith("https://")) {
          errors.push(`page ${p.route}: video.videoUrl is required and must start with https://`);
        } else {
          // Only allow exact hosts we know how to convert to a sandboxed
          // embed URL. Matches the renderer in components/sites/sections/
          // video.tsx one-to-one — reject here, do not iframe there.
          let host: string | null = null;
          try {
            host = new URL(s.videoUrl).hostname.toLowerCase().replace(/^www\./, "");
          } catch {
            host = null;
          }
          const allowed = new Set(["youtube.com", "youtu.be", "vimeo.com", "m.youtube.com"]);
          if (!host || !allowed.has(host)) {
            errors.push(
              `page ${p.route}: video.videoUrl must be a youtube.com, youtu.be, or vimeo.com URL`,
            );
          }
        }
        if (s.startSeconds !== undefined) {
          if (typeof s.startSeconds !== "number" || !Number.isFinite(s.startSeconds) || s.startSeconds < 0) {
            errors.push(`page ${p.route}: video.startSeconds must be a non-negative number`);
          }
        }
        if (s.provider !== undefined && s.provider !== "youtube" && s.provider !== "vimeo") {
          errors.push(`page ${p.route}: video.provider must be "youtube" or "vimeo"`);
        }
      }
      if (s.type === "testimonial") {
        const items = Array.isArray(s.items) ? s.items : [];
        items.forEach((it, i) => {
          if (typeof it.quote !== "string" || it.quote.length === 0) {
            errors.push(`page ${p.route}: testimonial.items[${i}].quote required`);
          }
          if (typeof it.authorName !== "string" || it.authorName.length === 0) {
            errors.push(`page ${p.route}: testimonial.items[${i}].authorName required`);
          }
          if (it.authorPhotoUrl !== undefined) {
            if (typeof it.authorPhotoUrl !== "string" || !it.authorPhotoUrl.startsWith("https://")) {
              errors.push(`page ${p.route}: testimonial.items[${i}].authorPhotoUrl must start with https://`);
            }
          }
        });
      }
      if (s.type === "pricing") {
        const items = Array.isArray(s.items) ? s.items : [];
        items.forEach((it, i) => {
          if (typeof it.name !== "string" || it.name.length === 0) {
            errors.push(`page ${p.route}: pricing.items[${i}].name required`);
          }
          if (typeof it.price !== "string" || it.price.length === 0) {
            errors.push(`page ${p.route}: pricing.items[${i}].price required`);
          }
          if (!Array.isArray(it.features) || it.features.length === 0) {
            errors.push(`page ${p.route}: pricing.items[${i}].features must be a non-empty array`);
          } else if (!it.features.every((f) => typeof f === "string")) {
            errors.push(`page ${p.route}: pricing.items[${i}].features must be all strings`);
          }
        });
      }
      if (s.type === "faq") {
        const items = Array.isArray(s.items) ? s.items : [];
        items.forEach((it, i) => {
          if (typeof it.question !== "string" || it.question.length === 0) {
            errors.push(`page ${p.route}: faq.items[${i}].question required`);
          }
          if (typeof it.answer !== "string" || it.answer.length === 0) {
            errors.push(`page ${p.route}: faq.items[${i}].answer required`);
          }
        });
      }
    }
  }
  if (errors.length > 0) throw new BriefValidationError(errors);
}

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
  /**
   * Per-page SEO overrides. Each field individually overrides
   * `SiteBrief.defaultSeo`; missing fields inherit. Optional.
   */
  seo?: PageSeo;
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
/**
 * Legacy narrow font shape — kept as an alias for `FontStack` for
 * back-compat with any caller typed against `SiteThemeFont` before the
 * design-token expansion (Path C Phase 1 · Stream P4). New callers should
 * prefer `FontStack` directly. `normalizeFont()` below accepts either.
 */
export interface SiteThemeFont {
  family?: string;
  googleFontName?: string;
  weightRegular?: number;
  weightMedium?: number;
  weightBold?: number;
  bodyFamily?: string;
}

/**
 * Typed design-token scales surfaced by the ThemeEditor. Every scale is
 * fully optional — an un-edited brief keeps its existing behavior. The
 * template picks defaults via `resolveThemeTokens()` in site-theme-tokens.ts.
 * Values are strings (CSS dimensions / durations / easings) because we emit
 * them verbatim into `--wp-*` custom properties; zero runtime math.
 */
export interface SpacingScale {
  xs?: string;
  sm?: string;
  md?: string;
  lg?: string;
  xl?: string;
  "2xl"?: string;
}

export interface RadiusScale {
  none?: string;
  sm?: string;
  md?: string;
  lg?: string;
  full?: string;
}

export interface TypeScaleEntry {
  fontSize: string;
  lineHeight: string;
}

export interface TypeScale {
  xs?: TypeScaleEntry;
  sm?: TypeScaleEntry;
  base?: TypeScaleEntry;
  lg?: TypeScaleEntry;
  xl?: TypeScaleEntry;
  "2xl"?: TypeScaleEntry;
  "3xl"?: TypeScaleEntry;
  "4xl"?: TypeScaleEntry;
  display?: TypeScaleEntry;
}

export interface FontStack {
  family?: string;
  googleFontName?: string;
  weightRegular?: number;
  weightMedium?: number;
  weightBold?: number;
  bodyFamily?: string;
}

export interface MotionScale {
  fast?: string;
  normal?: string;
  slow?: string;
  ease?: string;
}

export interface SiteTheme {
  colors?: SiteThemeColors;
  font?: FontStack;
  spacing?: SpacingScale;
  radius?: RadiusScale;
  typeScale?: TypeScale;
  motion?: MotionScale;
}

/**
 * Accept either the pre-P4 `{ family?: string }` shape or the full
 * `FontStack` and return a FontStack. Pure, no allocation when the input
 * already matches. Callers that were written before the design-token
 * expansion keep working without any change.
 */
export function normalizeFont(
  f: FontStack | { family?: string } | undefined,
): FontStack {
  if (!f || typeof f !== "object") return {};
  // FontStack is a superset of { family?: string } — nothing to do
  // structurally; return as-is (shallow-cast). We still copy so the caller
  // can mutate without affecting the input.
  return { ...(f as FontStack) };
}

/**
 * Per-page SEO metadata. All fields optional; every existing brief must
 * continue to validate green without emitting any SEO. When a page omits
 * `seo`, it inherits from `SiteBrief.defaultSeo`; when both are absent,
 * the only guaranteed head tag is a `<title>` derived from
 * `brief.product.name`. See `src/lib/seo-head.ts` for the fallback chain.
 */
export interface PageSeo {
  /** `<title>` — ≤70 chars recommended for SERP display. */
  title?: string;
  /** `<meta name="description">` — ≤170 chars (Google snippet budget). */
  description?: string;
  /** Absolute https URL for `<meta property="og:image">`. */
  ogImage?: string;
  /** Emits `<meta name="robots" content="noindex">` when true. */
  noIndex?: boolean;
  /** Absolute https URL for `<link rel="canonical">`. */
  canonical?: string;
}

/**
 * Site-level favicon configuration. When `src` is set it wins; otherwise
 * `autoGenerate` + `monogram` produce an inline SVG data URL via
 * `briefToFaviconHref` (no network request, no new infra).
 */
export interface SiteFavicon {
  /** Explicit favicon URL (absolute or site-relative). */
  src?: string;
  /** When true, generate an SVG favicon from theme colors + monogram. */
  autoGenerate?: boolean;
  /** 1-2 char fallback for the generated SVG (e.g. "A" for Acme). */
  monogram?: string;
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
  /**
   * Contact form configuration. `fields` is the list of required user-
   * facing inputs (e.g. `["name","email","message"]`). When the public
   * submission handler at `/api/public/forms/{siteId}/submit` receives
   * a POST, every field in this list must be present + non-empty, and
   * no extra fields (beyond the `_hp_website` honeypot) are accepted.
   *
   * `recipientEmail` (added in migration 034) is where accepted
   * submissions are sent via email. `subjectTemplate` overrides the
   * default subject line. `notifySlack` optionally fires a webhook on
   * every accepted submission in addition to the email.
   *
   * All fields are OPTIONAL — briefs authored before migration 034
   * continue to validate green without change.
   */
  contactForm?: {
    fields: string[];
    recipientEmail?: string;
    subjectTemplate?: string;
    notifySlack?: string;
  };
  /**
   * Site-wide SEO defaults. Each page's `seo` overrides these field-by-
   * field; missing fields on a page fall through to these defaults and
   * then to product-name/tagline fallbacks. All optional.
   */
  defaultSeo?: PageSeo;
  /**
   * Optional site-level favicon. Applies to every page. See SiteFavicon.
   */
  favicon?: SiteFavicon;
}

export type SiteStatus = "draft" | "provisioning" | "deploying" | "ready" | "failed";

/* ----------------------------- Validation ----------------------------- */

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}$/;
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;
const THEME_COLOR_FIELDS = ["primary", "accent", "bg", "fg", "muted"] as const;
// SEO field budgets. Google truncates titles ~60, descriptions ~160 in
// SERPs; we cap at 70/170 to leave headroom for brand suffixes and to
// match the wolfpack-site-template head emitter. URL matcher is strict
// enough to reject whitespace/relative paths while tolerating query
// strings and fragments (which canonical URLs frequently carry).
const SEO_TITLE_MAX = 70;
const SEO_DESCRIPTION_MAX = 170;
const URL_RE = /^https?:\/\/[^\s<>"']+$/i;
const FAVICON_SRC_RE = /^(https?:\/\/[^\s<>"']+|\/[^\s<>"']*|data:image\/[a-z+]+;base64,[A-Za-z0-9+/=]+)$/i;
const FAVICON_MONOGRAM_MAX = 2;

// Design tokens (Path C Phase 1 · Stream P4) -----------------------------
// Font weights accept the nine CSS weight keywords expressed numerically.
const FONT_WEIGHT_MIN = 100;
const FONT_WEIGHT_MAX = 900;
const SPACING_KEYS = ["xs", "sm", "md", "lg", "xl", "2xl"] as const;
const RADIUS_KEYS = ["none", "sm", "md", "lg", "full"] as const;
const TYPE_SCALE_KEYS = [
  "xs",
  "sm",
  "base",
  "lg",
  "xl",
  "2xl",
  "3xl",
  "4xl",
  "display",
] as const;
const MOTION_KEYS = ["fast", "normal", "slow"] as const;
// Accept any CSS dimension (px/rem/em/%/ch/vw/vh/vmin/vmax) or "0".
// We keep the regex intentionally permissive — the goal is to catch
// obvious garbage ("fast" as a spacing value, a number instead of a
// string) without becoming a CSS parser. The browser + template are the
// authoritative validators at render time.
const CSS_DIMENSION_RE = /^(0|-?\d*\.?\d+(px|rem|em|%|ch|vw|vh|vmin|vmax|pt|pc|in|cm|mm))$/i;
// line-height can be unitless ("1.4") OR dimensioned.
const LINE_HEIGHT_RE = /^(0|-?\d*\.?\d+(px|rem|em|%|ch|vw|vh|vmin|vmax|pt|pc|in|cm|mm)?|normal)$/i;
/**
 * Hard cap input lengths before .test() so any regex with overlapping
 * quantifier alternatives can't be driven to polynomial time by a long
 * adversarial string (CodeQL: js/polynomial-redos). 64 chars is far
 * larger than any legal CSS dimension / time / easing / hex value.
 */
const SHORT_INPUT_MAX = 64;
function shortStr(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (v.length > SHORT_INPUT_MAX) return null;
  return v;
}
// CSS times: "150ms" or "0.25s". No bare numbers — CSS requires a unit on
// non-zero values. "fast" is deliberately rejected so a word never slips
// into a CSS animation-duration.
const CSS_TIME_RE = /^(0|-?\d*\.?\d+(ms|s))$/i;
// cubic-bezier()/steps()/keyword easings. This is a light sanity gate;
// stricter validation would require a real CSS parser.
const CSS_EASING_RE =
  /^(linear|ease|ease-in|ease-out|ease-in-out|step-start|step-end|cubic-bezier\s*\([^)]*\)|steps\s*\([^)]*\))$/i;

function validateSpacing(
  raw: unknown,
  errors: string[],
): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("theme.spacing must be an object");
    return;
  }
  const r = raw as Record<string, unknown>;
  for (const k of SPACING_KEYS) {
    const v = r[k];
    if (v === undefined) continue;
    const s = shortStr(v);
    if (s === null || !CSS_DIMENSION_RE.test(s.trim())) {
      errors.push(`theme.spacing.${k} must be a CSS dimension string (e.g. "16px")`);
    }
  }
}

function validateRadius(
  raw: unknown,
  errors: string[],
): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("theme.radius must be an object");
    return;
  }
  const r = raw as Record<string, unknown>;
  for (const k of RADIUS_KEYS) {
    const v = r[k];
    if (v === undefined) continue;
    const s = shortStr(v);
    if (s === null || !CSS_DIMENSION_RE.test(s.trim())) {
      errors.push(`theme.radius.${k} must be a CSS dimension string (e.g. "8px", "9999px")`);
    }
  }
}

function validateTypeScale(
  raw: unknown,
  errors: string[],
): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("theme.typeScale must be an object");
    return;
  }
  const r = raw as Record<string, unknown>;
  for (const k of TYPE_SCALE_KEYS) {
    const entry = r[k];
    if (entry === undefined) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      errors.push(`theme.typeScale.${k} must be an object with fontSize and lineHeight`);
      continue;
    }
    const e = entry as Record<string, unknown>;
    const fs = shortStr(e.fontSize);
    if (fs === null || !CSS_DIMENSION_RE.test(fs.trim())) {
      errors.push(`theme.typeScale.${k}.fontSize must be a CSS dimension string`);
    }
    const lh = shortStr(e.lineHeight);
    if (lh === null || !LINE_HEIGHT_RE.test(lh.trim())) {
      errors.push(
        `theme.typeScale.${k}.lineHeight must be a CSS dimension, unitless ratio, or "normal"`,
      );
    }
  }
}

function validateMotion(
  raw: unknown,
  errors: string[],
): void {
  if (raw === undefined) return;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("theme.motion must be an object");
    return;
  }
  const r = raw as Record<string, unknown>;
  for (const k of MOTION_KEYS) {
    const v = r[k];
    if (v === undefined) continue;
    const s = shortStr(v);
    if (s === null || !CSS_TIME_RE.test(s.trim())) {
      errors.push(`theme.motion.${k} must be a CSS time string (e.g. "150ms", "0.25s")`);
    }
  }
  if (r.ease !== undefined) {
    const ease = shortStr(r.ease);
    if (ease === null || !CSS_EASING_RE.test(ease.trim())) {
      errors.push(
        'theme.motion.ease must be a CSS easing (e.g. "ease-in-out" or "cubic-bezier(...)")',
      );
    }
  }
}

function validateFontStack(
  raw: unknown,
  errors: string[],
): void {
  if (raw === undefined) return;
  if (typeof raw === "string") {
    // Legacy flat form: `font: "Inter"` — enforce length only.
    if (raw.length > 100) {
      errors.push("theme.font must be a string of at most 100 chars");
    }
    return;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    errors.push("theme.font must be an object or string");
    return;
  }
  const f = raw as Record<string, unknown>;
  if (f.family !== undefined) {
    if (typeof f.family !== "string" || f.family.length > 100) {
      errors.push("theme.font.family must be a string of at most 100 chars");
    }
  }
  if (f.googleFontName !== undefined && typeof f.googleFontName !== "string") {
    errors.push("theme.font.googleFontName must be a string");
  }
  if (f.bodyFamily !== undefined) {
    if (typeof f.bodyFamily !== "string" || f.bodyFamily.length > 100) {
      errors.push("theme.font.bodyFamily must be a string of at most 100 chars");
    }
  }
  for (const w of ["weightRegular", "weightMedium", "weightBold"] as const) {
    const v = f[w];
    if (v === undefined) continue;
    if (
      typeof v !== "number" ||
      !Number.isFinite(v) ||
      v < FONT_WEIGHT_MIN ||
      v > FONT_WEIGHT_MAX
    ) {
      errors.push(`theme.font.${w} must be a number between ${FONT_WEIGHT_MIN} and ${FONT_WEIGHT_MAX}`);
    }
  }
}

/**
 * Validate a PageSeo blob. Collects errors into `errors[]` with a prefix
 * that identifies the source (page route or "defaultSeo"). All fields are
 * optional — an empty object `{}` is valid. Exported for reuse in tests.
 */
export function validatePageSeo(
  seo: unknown,
  prefix: string,
  errors: string[],
): void {
  if (seo === undefined) return;
  if (!seo || typeof seo !== "object" || Array.isArray(seo)) {
    errors.push(`${prefix} must be an object`);
    return;
  }
  const s = seo as Record<string, unknown>;
  if (s.title !== undefined) {
    if (typeof s.title !== "string") {
      errors.push(`${prefix}.title must be a string`);
    } else if (s.title.length > SEO_TITLE_MAX) {
      errors.push(`${prefix}.title must be at most ${SEO_TITLE_MAX} characters`);
    }
  }
  if (s.description !== undefined) {
    if (typeof s.description !== "string") {
      errors.push(`${prefix}.description must be a string`);
    } else if (s.description.length > SEO_DESCRIPTION_MAX) {
      errors.push(
        `${prefix}.description must be at most ${SEO_DESCRIPTION_MAX} characters`,
      );
    }
  }
  if (s.ogImage !== undefined) {
    if (typeof s.ogImage !== "string" || !URL_RE.test(s.ogImage)) {
      errors.push(`${prefix}.ogImage must be an absolute http(s) URL`);
    }
  }
  if (s.noIndex !== undefined && typeof s.noIndex !== "boolean") {
    errors.push(`${prefix}.noIndex must be a boolean`);
  }
  if (s.canonical !== undefined) {
    if (typeof s.canonical !== "string" || !URL_RE.test(s.canonical)) {
      errors.push(`${prefix}.canonical must be an absolute http(s) URL`);
    }
  }
}

/**
 * Validate a SiteFavicon blob. All fields optional. Exported for tests.
 */
export function validateFavicon(
  fav: unknown,
  errors: string[],
): void {
  if (fav === undefined) return;
  if (!fav || typeof fav !== "object" || Array.isArray(fav)) {
    errors.push("favicon must be an object");
    return;
  }
  const f = fav as Record<string, unknown>;
  if (f.src !== undefined) {
    if (typeof f.src !== "string" || !FAVICON_SRC_RE.test(f.src)) {
      errors.push(
        "favicon.src must be an http(s) URL, a site-relative path starting with /, or a data:image URL",
      );
    }
  }
  if (f.autoGenerate !== undefined && typeof f.autoGenerate !== "boolean") {
    errors.push("favicon.autoGenerate must be a boolean");
  }
  if (f.monogram !== undefined) {
    if (typeof f.monogram !== "string") {
      errors.push("favicon.monogram must be a string");
    } else if (f.monogram.length > FAVICON_MONOGRAM_MAX) {
      errors.push(
        `favicon.monogram must be at most ${FAVICON_MONOGRAM_MAX} characters`,
      );
    }
  }
}

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
  if (
    b.product?.supportEmail &&
    (b.product.supportEmail.length > 254 ||
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(b.product.supportEmail))
  ) {
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
      validateFontStack(t.font, errors);
      // Design-token scales (Path C Phase 1 · Stream P4). Every scale is
      // optional; unset keys fall through to `DEFAULT_*` constants in
      // site-theme-tokens.ts at render time.
      validateSpacing(t.spacing, errors);
      validateRadius(t.radius, errors);
      validateTypeScale(t.typeScale, errors);
      validateMotion(t.motion, errors);
    }
  }
  // Site-level SEO + favicon defaults. All optional.
  validatePageSeo((b as Record<string, unknown>).defaultSeo, "defaultSeo", errors);
  validateFavicon((b as Record<string, unknown>).favicon, errors);

  // Contact form — all fields optional. When present, enforce shapes so
  // the public submission handler can trust the brief without re-checking.
  const contactFormRaw = (b as Record<string, unknown>).contactForm;
  if (contactFormRaw !== undefined) {
    if (!contactFormRaw || typeof contactFormRaw !== "object" || Array.isArray(contactFormRaw)) {
      errors.push("contactForm must be an object");
    } else {
      const cf = contactFormRaw as Record<string, unknown>;
      if (cf.fields !== undefined) {
        if (!Array.isArray(cf.fields)) {
          errors.push("contactForm.fields must be an array");
        } else if (!cf.fields.every((f) => typeof f === "string" && f.length > 0 && f.length <= 64)) {
          errors.push(
            "contactForm.fields must be non-empty strings of at most 64 chars each",
          );
        }
      }
      if (cf.recipientEmail !== undefined) {
        if (
          typeof cf.recipientEmail !== "string" ||
          cf.recipientEmail.length > 254 ||
          !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cf.recipientEmail)
        ) {
          errors.push("contactForm.recipientEmail must be a valid email");
        }
      }
      if (cf.subjectTemplate !== undefined) {
        if (typeof cf.subjectTemplate !== "string") {
          errors.push("contactForm.subjectTemplate must be a string");
        } else if (cf.subjectTemplate.length > 120) {
          errors.push("contactForm.subjectTemplate must be at most 120 characters");
        }
      }
      if (cf.notifySlack !== undefined) {
        if (
          typeof cf.notifySlack !== "string" ||
          !cf.notifySlack.startsWith("https://hooks.slack.com/")
        ) {
          errors.push(
            "contactForm.notifySlack must be an https://hooks.slack.com/ webhook URL",
          );
        }
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
    // Per-page SEO overrides. Scoped by route so errors are traceable.
    validatePageSeo(
      (p as unknown as Record<string, unknown>).seo,
      `page ${p.route}.seo`,
      errors,
    );
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

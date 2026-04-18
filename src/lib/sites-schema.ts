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
] as const;
export type SectionType = (typeof SUPPORTED_SECTION_TYPES)[number];

export interface BriefSection {
  type: SectionType;
  heading?: string;
  body?: string;
  cta?: { label: string; href: string };
  backgroundImage?: string;
  height?: string;
  items?: Array<{
    title?: string;
    body?: string;
    accent?: boolean;
    badge?: string;
    label?: string;
    value?: number;
    prefix?: string;
    suffix?: string;
  }>;
  images?: Array<{ src: string; alt?: string } | string>;
  attribution?: string;
}

export interface BriefPage {
  route: string;
  title?: string;
  sections: BriefSection[];
}

export interface SiteBrief {
  client: string;
  product: {
    name: string;
    tagline?: string;
    domain?: string;
    supportEmail?: string;
  };
  theme?: Record<string, string>;
  pages: BriefPage[];
  contactForm?: { fields: string[] };
}

export type SiteStatus = "draft" | "provisioning" | "deploying" | "ready" | "failed";

/* ----------------------------- Validation ----------------------------- */

const SLUG_RE = /^[a-z][a-z0-9-]{1,38}$/;

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
    }
  }
  if (errors.length > 0) throw new BriefValidationError(errors);
}

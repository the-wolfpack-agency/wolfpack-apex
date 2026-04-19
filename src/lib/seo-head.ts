/**
 * seo-head — build `<head>` metadata for a SiteBrief page.
 *
 * Pure function. Returns an array of descriptor objects the preview page
 * renders directly (via DOM API on mount) and the deployed template can
 * consume too. Zero dependencies on React so it ships cleanly to both
 * surfaces.
 *
 * Fallback chain per field:
 *   title       → page.seo.title | brief.defaultSeo.title | product.name
 *   description → page.seo.description | brief.defaultSeo.description | product.tagline
 *   ogImage     → page.seo.ogImage | brief.defaultSeo.ogImage
 *   noIndex     → page.seo.noIndex | brief.defaultSeo.noIndex
 *   canonical   → page.seo.canonical | brief.defaultSeo.canonical
 *   favicon     → briefToFaviconHref(brief)
 *
 * TODO(template-repo): wolfpack-site-template's Next.js pages should
 * import `buildSeoMetaTags` and emit the same descriptors into their
 * server-rendered `<head>` so social-sharing parity is preserved in
 * production. Until that migration lands, the preview route (which we
 * DO control in Instinct) is where designers validate SEO.
 */

import type { SiteBrief } from "@/lib/sites-schema";
import { briefToFaviconHref } from "@/lib/favicon-generator";

export interface SeoMetaTag {
  /** The HTML element to emit. */
  tag: "title" | "meta" | "link";
  /** Attribute bag. For `<title>`, pass the text as `{ text: "..." }`. */
  attrs: Record<string, string>;
}

export interface BuildSeoArgs {
  brief: SiteBrief;
  pageIndex: number;
  /**
   * Optional — when supplied, we resolve relative og:image/canonical
   * references against this origin. Callers on the preview route pass
   * `window.location.origin` here.
   */
  previewUrl?: string;
}

/**
 * Resolve a URL string against `previewUrl` when present. If the input
 * is already absolute (http/https/data:), return it unchanged.
 */
function resolveUrl(url: string, base: string | undefined): string {
  if (!url) return url;
  if (/^(https?:|data:)/i.test(url)) return url;
  if (!base) return url;
  try {
    return new URL(url, base).toString();
  } catch {
    return url;
  }
}

/**
 * Build the head-tag descriptors for a given page of a brief. Never
 * throws on a malformed brief — returns `[]` if the brief has no pages
 * (the preview route renders an empty state in that case).
 */
export function buildSeoMetaTags(args: BuildSeoArgs): SeoMetaTag[] {
  const { brief, pageIndex, previewUrl } = args;
  if (!brief || !Array.isArray(brief.pages) || brief.pages.length === 0) {
    return [];
  }
  const page = brief.pages[pageIndex] ?? brief.pages[0];
  const pageSeo = page.seo ?? {};
  const defaults = brief.defaultSeo ?? {};
  const product = brief.product ?? { name: "" };

  // Fallback chain per field — page → defaults → product-derived
  const title =
    firstString(pageSeo.title, defaults.title) ??
    product.name ??
    "";
  const description =
    firstString(pageSeo.description, defaults.description) ??
    product.tagline ??
    undefined;
  const ogImage = firstString(pageSeo.ogImage, defaults.ogImage);
  const canonical = firstString(pageSeo.canonical, defaults.canonical);
  // noIndex is boolean-aware: page wins if defined (including false), else default.
  const noIndex =
    typeof pageSeo.noIndex === "boolean"
      ? pageSeo.noIndex
      : typeof defaults.noIndex === "boolean"
        ? defaults.noIndex
        : false;

  const tags: SeoMetaTag[] = [];

  // <title> is mandatory — even if everything else is empty, emit a
  // title so the browser tab and social share card have something.
  tags.push({ tag: "title", attrs: { text: title || "" } });

  if (description) {
    tags.push({ tag: "meta", attrs: { name: "description", content: description } });
    tags.push({ tag: "meta", attrs: { property: "og:description", content: description } });
  }
  // og:title always follows whatever we chose for <title>, so social
  // cards and SERPs agree.
  if (title) {
    tags.push({ tag: "meta", attrs: { property: "og:title", content: title } });
  }
  if (ogImage) {
    tags.push({
      tag: "meta",
      attrs: { property: "og:image", content: resolveUrl(ogImage, previewUrl) },
    });
  }
  // og:type — every page is a `website` unless we add blog posts later.
  // Emit unconditionally so link scrapers have a discriminant.
  tags.push({ tag: "meta", attrs: { property: "og:type", content: "website" } });

  if (canonical) {
    tags.push({
      tag: "link",
      attrs: { rel: "canonical", href: resolveUrl(canonical, previewUrl) },
    });
  }
  if (noIndex) {
    tags.push({ tag: "meta", attrs: { name: "robots", content: "noindex" } });
  }

  const faviconHref = briefToFaviconHref(brief);
  if (faviconHref) {
    // Data URLs use image/svg+xml; explicit http URLs may be any image type.
    const type = faviconHref.startsWith("data:image/svg+xml")
      ? "image/svg+xml"
      : undefined;
    const attrs: Record<string, string> = { rel: "icon", href: faviconHref };
    if (type) attrs.type = type;
    tags.push({ tag: "link", attrs });
  }

  return tags;
}

/**
 * Return the first defined, non-empty string from the arguments. Helper
 * for the field-by-field fallback chain above.
 */
function firstString(...candidates: Array<string | undefined>): string | undefined {
  for (const c of candidates) {
    if (typeof c === "string" && c.length > 0) return c;
  }
  return undefined;
}

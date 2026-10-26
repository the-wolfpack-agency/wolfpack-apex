/**
 * The real hostname for a Forcefield site label.
 *
 * Events carry an internal site label (props.site): "instinct" is this app
 * (src/middleware.ts), "weekendwithporsche" and "aidanmulready" are the labels
 * their shims send, and newer sites already send a hostname ("ogiam.com"). An
 * alert should name the site a reader recognizes, so a label is mapped to its
 * host from the existing configuration:
 *
 *   1. a label that already is a hostname is returned as is;
 *   2. "instinct" is the Instinct public URL (INSTINCT_PUBLIC_URL, defaults to
 *      the production alias), the same base every email links to;
 *   3. otherwise the product catalog (src/lib/products.ts): a product whose id
 *      equals the label, or whose host is the label plus a TLD
 *      ("weekendwithporsche" -> weekendwithporsche.com).
 *
 * Unknown labels fall back to the label itself. Pure; client-safe.
 */
import { listProducts } from "@/lib/products";
import { instinctPublicBaseUrl } from "@/lib/mail/public-base-url";

/** The Instinct app's own label (src/middleware.ts). */
export const INSTINCT_SITE_LABEL = "instinct";

const HOSTNAME = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** The hostname for a site label, or the label when no host is known. */
export function siteHost(label: string | undefined | null): string {
  const raw = (label ?? "").trim();
  if (!raw) return "";
  const l = raw.toLowerCase();
  if (HOSTNAME.test(l)) return l;
  if (l === INSTINCT_SITE_LABEL) return hostOf(instinctPublicBaseUrl()) ?? raw;
  for (const p of listProducts()) {
    const host = p.url ? hostOf(p.url) : null;
    if (!host) continue;
    if (p.id.toLowerCase() === l) return host;
    const bare = host.replace(/^www\./, "");
    if (bare.slice(0, bare.indexOf(".")) === l) return host;
  }
  return raw;
}

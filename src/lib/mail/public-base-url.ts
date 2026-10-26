/**
 * The absolute base URL every outbound email links to. One definition so an
 * email never carries a relative link (useless from an inbox) or a preview
 * deployment URL. Override with INSTINCT_PUBLIC_URL; defaults to the production
 * alias. A trailing slash is trimmed so callers can append "/path".
 */
export const DEFAULT_INSTINCT_PUBLIC_URL = "https://wolfpack-instinct.vercel.app";

export function instinctPublicBaseUrl(): string {
  return process.env.INSTINCT_PUBLIC_URL?.replace(/\/$/, "") ?? DEFAULT_INSTINCT_PUBLIC_URL;
}

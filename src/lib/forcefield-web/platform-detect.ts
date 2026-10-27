/**
 * Which platform a website runs on, from one read-only look at its home page.
 *
 * Used by self-serve signup to show the one install option that fits the site:
 *   - wordpress  the Forcefield WordPress plugin (connects itself, no key to copy),
 *   - vercel     the Vercel / Next.js install,
 *   - other      the "connect it for me" concierge request, plus the DIY options.
 *
 * The fetch is a single GET of the home page through the platform-scan SSRF
 * guard (assertScannableUrl), re-checked on every redirect hop (at most 3),
 * with a short timeout and a byte cap. Nothing is stored except the result
 * label. A failure never blocks signup: it degrades to "other".
 *
 * Local development only: FORCEFIELD_DEV_SITE_ORIGINS (a comma list of origins
 * such as http://wp.localtest.me:8080) lets a throwaway local site be reached.
 * It is ignored whenever NODE_ENV is "production", so a deployed build always
 * runs the full guard.
 *
 * Deterministic: no model client.
 */
import { assertScannableUrl } from "@/lib/platform-scan/ssrf-guard";

export type DetectedPlatform = "wordpress" | "vercel" | "other";

export interface PlatformDetection {
  platform: DetectedPlatform;
  /** Short, coarse signal names that matched (never page content). */
  evidence: string[];
  /** False when the home page could not be read (the result is then "other"). */
  checked: boolean;
  reason?: string;
}

export const DETECT_TIMEOUT_MS = 5000;
export const DETECT_MAX_BYTES = 512 * 1024;
export const DETECT_MAX_REDIRECTS = 3;
const USER_AGENT = "OGIAM-Forcefield-Setup/1.0 (+https://ogiam.com/forcefield)";

/** The connector key a detected platform maps to (connectors.ts). */
export function connectorForPlatform(p: DetectedPlatform | null | undefined): "wordpress" | "vercel" | "generic" {
  return p === "wordpress" ? "wordpress" : p === "vercel" ? "vercel" : "generic";
}

export function isDetectedPlatform(v: unknown): v is DetectedPlatform {
  return v === "wordpress" || v === "vercel" || v === "other";
}

/* ------------------------------ dev override ------------------------------ */

function devOrigins(): string[] {
  if (process.env.NODE_ENV === "production") return [];
  return String(process.env.FORCEFIELD_DEV_SITE_ORIGINS ?? "")
    .split(",")
    .map((s) => s.trim().replace(/\/$/, ""))
    .filter((s) => /^https?:\/\/[^/]+$/i.test(s));
}

/** The origin Forcefield reaches a site at: https://<site>, or a matching local
 *  development origin (never in production). */
export function siteOrigin(site: string): string {
  const host = String(site ?? "").trim().toLowerCase();
  for (const o of devOrigins()) {
    try {
      if (new URL(o).host.toLowerCase() === host) return o;
    } catch {
      /* skip malformed */
    }
  }
  return `https://${host}`;
}

/** The SSRF guard for a site fetch. A local development origin is exempt only
 *  outside production; everything else goes through assertScannableUrl. */
export async function assertSiteFetchable(url: string, guard: (u: string) => Promise<void> = assertScannableUrl): Promise<void> {
  try {
    const origin = new URL(url).origin;
    if (devOrigins().includes(origin)) return;
  } catch {
    /* fall through to the guard, which rejects it */
  }
  await guard(url);
}

/* ------------------------------- classifier ------------------------------- */

type HeaderBag = { get(name: string): string | null };

const WP_HTML: [RegExp, string][] = [
  [/<meta[^>]+name=["']generator["'][^>]+content=["']WordPress/i, "generator_meta"],
  [/\/wp-content\/(themes|plugins|uploads)\//i, "wp_content"],
  [/\/wp-includes\//i, "wp_includes"],
  [/rel=["']https:\/\/api\.w\.org\/["']/i, "wp_api_link"],
];
const NEXT_HTML: [RegExp, string][] = [
  [/\/_next\/static\//, "next_static"],
  [/id=["']__NEXT_DATA__["']/, "next_data"],
];

/** Classify a fetched home page. Pure; exported for tests. */
export function classifySiteResponse(headers: HeaderBag, html: string): { platform: DetectedPlatform; evidence: string[] } {
  const h = (n: string) => (headers.get(n) ?? "").toLowerCase();
  const wp: string[] = [];
  const vercel: string[] = [];
  // WordPress announces its REST API with Link: <...>; rel="https://api.w.org/".
  if (/rel="?https:\/\/api\.w\.org\/"?/.test(h("link"))) wp.push("wp_api_header");
  if (h("x-powered-by").includes("wp engine") || h("x-pingback").includes("xmlrpc.php")) wp.push("wp_header");
  for (const [re, name] of WP_HTML) if (re.test(html)) wp.push(name);
  if (h("x-vercel-id") || h("x-vercel-cache")) vercel.push("vercel_header");
  if (h("server") === "vercel") vercel.push("vercel_server");
  if (h("x-powered-by").includes("next.js") || headers.get("x-nextjs-cache") !== null || headers.get("x-nextjs-prerender") !== null) vercel.push("next_header");
  for (const [re, name] of NEXT_HTML) if (re.test(html)) vercel.push(name);
  // WordPress wins a tie: a WordPress site behind Vercel's edge still installs the plugin.
  if (wp.length > 0) return { platform: "wordpress", evidence: wp };
  if (vercel.length > 0) return { platform: "vercel", evidence: vercel };
  return { platform: "other", evidence: [] };
}

/* --------------------------------- fetch ---------------------------------- */

export interface DetectDeps {
  fetchImpl?: typeof fetch;
  guard?: (url: string) => Promise<void>;
  timeoutMs?: number;
}

async function readCapped(res: Response, max: number): Promise<string> {
  const body = res.body;
  if (!body || typeof (body as ReadableStream).getReader !== "function") return (await res.text()).slice(0, max);
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < max) {
    const { value, done } = await reader.read();
    if (done || !value) break;
    chunks.push(value);
    total += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks.map((c) => Buffer.from(c))).toString("utf8").slice(0, max);
}

/** Detect a site's platform. Never throws: any failure is { platform: "other", checked: false }. */
export async function detectSitePlatform(site: string, deps: DetectDeps = {}): Promise<PlatformDetection> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const guard = deps.guard;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DETECT_TIMEOUT_MS);
  try {
    let url = `${siteOrigin(site)}/`;
    for (let hop = 0; hop <= DETECT_MAX_REDIRECTS; hop++) {
      try {
        await assertSiteFetchable(url, guard);
      } catch {
        return { platform: "other", evidence: [], checked: false, reason: "ssrf_blocked" };
      }
      const res = await fetchImpl(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: { "User-Agent": USER_AGENT, Accept: "text/html,application/xhtml+xml" },
      });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        if (!loc) return { platform: "other", evidence: [], checked: false, reason: "redirect_without_location" };
        const next = new URL(loc, url);
        if (next.protocol !== "https:" && next.protocol !== "http:") return { platform: "other", evidence: [], checked: false, reason: "redirect_scheme" };
        url = next.toString();
        continue;
      }
      // A non-200 page still carries platform headers (a WordPress 404 page, a
      // Vercel 401 preview), so classify whatever came back.
      const html = await readCapped(res, DETECT_MAX_BYTES).catch(() => "");
      const c = classifySiteResponse(res.headers, html);
      return { ...c, checked: true, ...(res.ok ? {} : { reason: `http_${res.status}` }) };
    }
    return { platform: "other", evidence: [], checked: false, reason: "too_many_redirects" };
  } catch (err) {
    const aborted = (err as Error)?.name === "AbortError";
    return { platform: "other", evidence: [], checked: false, reason: aborted ? "timeout" : "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The compliance collector that works without a browser.
 *
 * WHY THIS EXISTS AT ALL
 *
 * collect.ts drives a real browser, which is the better instrument: it sees what
 * the page actually did, including scripts that inject other scripts. It cannot
 * run in a Vercel function — there is no chromium binary there — so a
 * click-and-go scan built only on it would degrade every single time in
 * production while passing every test locally. That is precisely the class of
 * failure this codebase keeps getting burned by, so the button is built on the
 * tier that genuinely runs where it is deployed, and the browser tier stays
 * available for a runner that has a browser.
 *
 * WHAT A REFERENCE IS AND IS NOT
 *
 * This reads the HTML the server sent and extracts the hosts it REFERENCES. A
 * reference is not an observation. A `<script src>` in the served markup will
 * almost certainly load, so treating it as a contact is fair, and it fires on
 * page load before any consent interaction, so `atMs: 0` is accurate rather
 * than convenient. But a tracker injected later by another script is invisible
 * here, and pretending otherwise would be the whole feature lying.
 *
 * Every request therefore carries `status: null` — we did not fetch it, so we
 * do not know how it went — and the tier is stamped on the result so run.ts can
 * refuse to turn "we did not see it" into "it is not there".
 *
 * Limits mirror brand-url-import.ts (timeout, byte cap, redirect cap) rather
 * than inventing a second set of numbers for the same job.
 */
import { resolveHref } from "@/lib/brand-url-import";
import { hostOf } from "../network/observations";
import type { NetworkObservation } from "../network/observations";
import type { PageFacts } from "./findings";
import { normalizeHeaders } from "./collect";

export const STATIC_SCAN_TIMEOUT_MS = 15_000;
export const STATIC_SCAN_MAX_BYTES = 3 * 1024 * 1024;
export const STATIC_SCAN_USER_AGENT =
  "Instinct-ComplianceScanner/1.0 (+https://wolfpack-instinct.vercel.app/about)";

/** Attributes that name an outbound host, and the resource type each implies. */
const REF_PATTERNS: readonly { re: RegExp; resourceType: string }[] = [
  { re: /<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, resourceType: "script" },
  { re: /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, resourceType: "image" },
  { re: /<iframe\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, resourceType: "frame" },
  { re: /<link\b[^>]*\bhref\s*=\s*["']([^"']+)["']/gi, resourceType: "stylesheet" },
  { re: /<source\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi, resourceType: "media" },
];

/**
 * Consent platforms we can recognise in served markup.
 *
 * Deliberately short and vendor-specific. A generic search for the word
 * "cookie" matches a privacy policy link, a blog post, and a recipe site, and a
 * false "banner present" downgrades the most serious finding this scan makes.
 * When we cannot tell, run.ts reports unverifiable rather than guessing either
 * way.
 */
const CMP_HOSTS = [
  "cookiebot.com",
  "cookielaw.org",
  "onetrust.com",
  "usercentrics.eu",
  "cookieyes.com",
  "iubenda.com",
  "termly.io",
  "osano.com",
  "quantcast.com",
  "trustarc.com",
  "civicuk.com",
  "klaro",
  "cookieconsent",
];

export function extractTitle(html: string): string | null {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  const t = m?.[1]?.replace(/\s+/g, " ").trim();
  return t ? t : null;
}

export function extractHtmlLang(html: string): string | null {
  const m = /<html\b[^>]*\blang\s*=\s*["']([^"']*)["']/i.exec(html);
  const v = m?.[1]?.trim();
  return v ? v : null;
}

/** Anchors, with their visible text flattened. The text is what the policy-link
 *  matcher reads, so nested markup is stripped rather than left as tags. */
export function extractLinks(html: string, base: URL): { href: string; text: string }[] {
  const out: { href: string; text: string }[] = [];
  const re = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  for (const m of html.matchAll(re)) {
    const href = resolveHref(m[1], base);
    if (!href) continue;
    const text = m[2].replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
    out.push({ href, text });
  }
  // Anchors with no closing tag in the captured form still matter for finding a
  // policy page, so pick up bare hrefs the paired pattern missed.
  const bare = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*\/?>/gi;
  for (const m of html.matchAll(bare)) {
    const href = resolveHref(m[1], base);
    if (!href || out.some((l) => l.href === href)) continue;
    out.push({ href, text: "" });
  }
  return out;
}

/** Hosts the served HTML points at, as observations. See the header: these are
 *  references, not observed requests, and status is null to say so. */
export function extractReferences(html: string, pageUrl: string): NetworkObservation[] {
  let base: URL;
  try {
    base = new URL(pageUrl);
  } catch {
    return [];
  }
  const seen = new Set<string>();
  const out: NetworkObservation[] = [];
  for (const { re, resourceType } of REF_PATTERNS) {
    for (const m of html.matchAll(re)) {
      const url = resolveHref(m[1], base);
      if (!url) continue;
      const host = hostOf(url);
      if (!host) continue;
      const key = `${host}|${resourceType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        url,
        pageUrl,
        resourceType,
        // Present in the initial HTML, so it loads before the visitor can have
        // interacted with anything. Accurate, not convenient.
        atMs: 0,
        // We did not request it, so we have no status. Saying 200 here would be
        // inventing evidence.
        status: null,
      });
    }
  }
  return out;
}

/** True only when a NAMED consent platform is present. See CMP_HOSTS. */
export function detectConsentPlatform(html: string): boolean {
  const lower = html.toLowerCase();
  return CMP_HOSTS.some((h) => lower.includes(h));
}

export interface StaticCollectDeps {
  fetchImpl?: typeof fetch;
  /** Injected so tests never depend on a real timer. */
  timeoutMs?: number;
}

export interface StaticCollectResult {
  facts: PageFacts;
  observations: NetworkObservation[];
  error?: string;
  /** The URL actually read, after redirects. A scan of a site that redirects to
   *  another host has scanned that other host, and the report must say so. */
  finalUrl: string;
}

function emptyFacts(headers: Record<string, string> = {}): PageFacts {
  return {
    links: [],
    htmlLang: null,
    title: null,
    headers,
    pageLoaded: false,
    consentAtMs: null,
    consentMechanismFound: false,
  };
}

/**
 * Fetch one page and gather what the checks need.
 *
 * Never throws. A site that is down, slow, or hostile produces a result saying
 * the page did not load, which every check turns into "unverifiable". A throw
 * would produce no report at all instead of a truthful one.
 */
export async function collectStatic(pageUrl: string, deps: StaticCollectDeps = {}): Promise<StaticCollectResult> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const timeoutMs = deps.timeoutMs ?? STATIC_SCAN_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetchImpl(pageUrl, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: { "user-agent": STATIC_SCAN_USER_AGENT, accept: "text/html,application/xhtml+xml" },
    });

    const headers = normalizeHeaders(Object.fromEntries(res.headers as unknown as Iterable<[string, string]>));
    const finalUrl = res.url || pageUrl;

    if (!res.ok) {
      // Headers still arrived, so the security-header check CAN be answered.
      // Discarding them because the status was not 200 would throw away real
      // evidence.
      return { facts: emptyFacts(headers), observations: [], error: `HTTP ${res.status}`, finalUrl };
    }

    const body = await res.text();
    const html = body.length > STATIC_SCAN_MAX_BYTES ? body.slice(0, STATIC_SCAN_MAX_BYTES) : body;

    let base: URL;
    try {
      base = new URL(finalUrl);
    } catch {
      return { facts: emptyFacts(headers), observations: [], error: "unreadable url", finalUrl };
    }

    return {
      facts: {
        links: extractLinks(html, base),
        htmlLang: extractHtmlLang(html),
        title: extractTitle(html),
        headers,
        pageLoaded: true,
        // A read-only scan never accepts a banner, so consent was never given.
        // Recording a time here would silently pass every tracker that fired
        // after it, turning the most serious finding into a pass.
        consentAtMs: null,
        consentMechanismFound: detectConsentPlatform(html),
      },
      observations: extractReferences(html, finalUrl),
      finalUrl,
    };
  } catch (err) {
    const aborted = err instanceof Error && (err.name === "AbortError" || /abort/i.test(err.message));
    return {
      facts: emptyFacts(),
      observations: [],
      error: aborted ? `timed out after ${timeoutMs}ms` : err instanceof Error ? err.message : "fetch failed",
      finalUrl: pageUrl,
    };
  } finally {
    clearTimeout(timer);
  }
}

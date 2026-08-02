/**
 * Gather what the compliance checks need from a live page.
 *
 * The judging half (findings.ts) is pure and tested on its own. This is the
 * half that visits the page, and it is deliberately dumb: it collects, it does
 * not decide. Every verdict still comes from findings.ts, so the rules stay in
 * one place and stay unit-testable without a browser.
 *
 * REUSE, NOT A SECOND CRAWLER
 *
 * The browser scan already programs against a minimal `ScanPage` interface with
 * zero Playwright import (browser/capture.ts), and already ships a read-only
 * network floor that aborts every non-GET request before it leaves the browser.
 * Both are used here unchanged. A compliance scan runs against a client's
 * PRODUCTION site, so "cannot mutate anything by construction" is not a nicety.
 *
 * The in-page collector is self-contained — it references no module-level symbol
 * — so a real browser can serialize it into evaluate() and a jsdom test can call
 * it directly. Same constraint the existing capture layer works under.
 *
 * WHAT IT DOES WHEN IT FAILS
 *
 * It returns facts with `pageLoaded: false` rather than throwing. findings.ts
 * turns that into "unverifiable" for every check, which is the honest answer: a
 * page we could not open tells us nothing, and a scan that threw here would
 * produce no report at all rather than a truthful one.
 */
import type { ScanPage } from "../browser/capture";
import { installReadOnlyFloor } from "../browser/capture";
import type { PageFacts } from "./findings";
import type { NetworkObservation } from "../network/observations";

/** Shape of the raw request records the page collector hands back. */
export interface RawRequest {
  url: string;
  resourceType: string;
  atMs: number;
  status: number | null;
}

/**
 * Read the facts a compliance check needs, from inside the page.
 *
 * Self-contained by requirement: no imports, no closure over module scope.
 *
 * Consent detection is deliberately conservative. It looks for the shapes a
 * banner actually takes — a dialog whose text asks about cookies or consent, or
 * a known CMP's global — and reports what it found rather than guessing at
 * intent. A false "banner present" would turn a critical finding into a pass,
 * so when it is unsure it says nothing, and findings.ts treats absence of a
 * banner as the more serious reading.
 */
export function collectPageFacts(): Omit<PageFacts, "pageLoaded" | "headers"> {
  const links = Array.from(document.querySelectorAll("a[href]"))
    .slice(0, 400)
    .map((a) => ({
      href: (a as HTMLAnchorElement).href || a.getAttribute("href") || "",
      text: (a.textContent || "").replace(/\s+/g, " ").trim().slice(0, 120),
    }))
    .filter((l) => l.href !== "");

  const CONSENT_TEXT = /\b(cookie|consent|privacy preferences|gdpr|we use cookies|accept all)\b/i;
  const w = window as unknown as Record<string, unknown>;
  // Known consent-management globals. Presence of one is strong evidence; the
  // list is short and precision-first, matching the detector philosophy.
  const knownCmp = ["OneTrust", "Cookiebot", "__tcfapi", "Osano", "Klaro", "CookieConsent"].some((k) => w[k] !== undefined);

  let bannerFound = knownCmp;
  if (!bannerFound) {
    const candidates = Array.from(document.querySelectorAll('[role="dialog"], [aria-modal="true"], [id*="cookie" i], [class*="cookie" i], [id*="consent" i], [class*="consent" i]'));
    bannerFound = candidates.some((el) => CONSENT_TEXT.test((el.textContent || "").slice(0, 600)));
  }

  return {
    links,
    htmlLang: document.documentElement.getAttribute("lang"),
    title: document.title || null,
    // Never assume consent was GIVEN. A banner that exists has not been
    // accepted, and reporting a time here would silently pass every tracker
    // that fired after it. Only an explicit acceptance sets this, which a
    // read-only scan never performs.
    consentAtMs: null,
    consentMechanismFound: bannerFound,
  };
}

export interface CollectDeps {
  /** Injected so tests run with no browser. */
  page: ScanPage;
  /** Injected clock; the page records offsets from navigation start. */
  now?: () => number;
}

export interface CollectResult {
  facts: PageFacts;
  observations: NetworkObservation[];
  /** Set when the page could not be visited, for the run record. */
  error?: string;
}

/** Lowercase every header key so lookups are predictable. */
export function normalizeHeaders(raw: Record<string, string> | undefined | null): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw ?? {})) out[k.toLowerCase()] = v;
  return out;
}

/**
 * Visit one page and gather everything the checks need.
 *
 * Requests are recorded from the `response` event, which fires for every
 * resource the page pulled — that is the observation set the compliance checks
 * and the anomaly detector both read.
 */
export async function collectForCompliance(pageUrl: string, deps: CollectDeps): Promise<CollectResult> {
  const { page } = deps;
  const now = deps.now ?? Date.now;
  const startedAt = now();
  const raw: RawRequest[] = [];

  // Safety first: no mutating request may leave the browser. A compliance scan
  // runs against a client's live site.
  await installReadOnlyFloor(page);

  page.on("response", (res: unknown) => {
    const r = res as { url?: () => string; status?: () => number; request?: () => { resourceType?: () => string } };
    try {
      const url = r.url?.() ?? "";
      if (!url) return;
      raw.push({
        url,
        resourceType: r.request?.()?.resourceType?.() ?? "other",
        atMs: Math.max(0, now() - startedAt),
        status: r.status?.() ?? null,
      });
    } catch {
      /* One unreadable response must not lose the rest of the capture. */
    }
  });

  let headers: Record<string, string> = {};
  try {
    const res = await page.goto(pageUrl);
    headers = normalizeHeaders(res?.headers?.());
  } catch (err) {
    return {
      facts: {
        links: [],
        htmlLang: null,
        title: null,
        headers: {},
        pageLoaded: false,
        consentAtMs: null,
        consentMechanismFound: false,
      },
      observations: [],
      error: err instanceof Error ? err.message : "navigation failed",
    };
  }

  let pageFacts: Omit<PageFacts, "pageLoaded" | "headers">;
  try {
    pageFacts = await page.evaluate(collectPageFacts);
  } catch (err) {
    // The page loaded but would not let us read it. Distinct from a failed
    // navigation, and still unverifiable rather than absent.
    return {
      facts: { links: [], htmlLang: null, title: null, headers, pageLoaded: false, consentAtMs: null, consentMechanismFound: false },
      observations: [],
      error: err instanceof Error ? err.message : "page evaluation failed",
    };
  }

  return {
    facts: { ...pageFacts, headers, pageLoaded: true },
    observations: raw.map((r) => ({
      url: r.url,
      pageUrl,
      resourceType: r.resourceType,
      atMs: r.atMs,
      status: r.status,
    })),
  };
}

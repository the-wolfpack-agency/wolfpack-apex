/**
 * brand-url-import — "already on-brand" seeding for the SiteBrief.
 *
 * A designer pastes a client's existing website URL; we scrape the
 * public markup + stylesheets + og:image to extract the brand's palette,
 * font family, and logo, then map that into the `SiteTheme` shape so the
 * new brief opens with those tokens pre-seeded. Replaces the "blank
 * slate" experience with "5 seconds of pre-filled, editable brand."
 *
 * Security posture (SSRF-first):
 *   - URL must be HTTPS unless the host is explicitly localhost/dev.
 *   - Hostname is checked against a blocklist of private + link-local
 *     + loopback ranges (IPv4 + IPv6). We do NOT resolve DNS to rebind
 *     at request time — DNS TOCTOU can defeat late checks; refusing the
 *     obvious literal-IP + metadata hostnames on the hot path eliminates
 *     the class of attack we care about for a designer-pasted URL.
 *   - 10s hard cap with AbortController on the fetch.
 *   - 2MB response truncation; anything above is ignored.
 *   - Max 3 redirects — we walk them manually via `redirect: "manual"`
 *     because the fetch spec's default allows unbounded hops.
 *   - A fixed User-Agent identifies Instinct so target sites can
 *     block/allow us intentionally instead of fingerprinting a browser.
 *
 * Parsing posture (no new runtime deps):
 *   - We regex-extract the handful of things we care about from the
 *     HTML <head> + inline <style> blocks. Full DOM parsing is overkill
 *     and pulling jsdom into the production bundle for a ~1KB payload
 *     of brand tokens is indefensible.
 *   - og:image, when present and PNG, gets run through the existing
 *     k-means palette extractor in `image-palette.ts` for a measured
 *     colour set to cross-check the CSS-variable set.
 *
 * Learning-loop note: every phase fires analytics.
 *   - brand_import_requested  — always, with only the hostname (no PII).
 *   - brand_import_completed  — ok path, with palette size + font count.
 *   - brand_import_failed     — failure path, with the typed reason.
 *   - brand_import_applied    — fires from the UI on "Apply to site",
 *     with the applied field list. This is the KPI: which scraped
 *     tokens do designers actually accept?
 */

import { extractPalette } from "./image-palette";
import { trackEvent } from "./analytics";

/* --------------------------------------------------------------------- *
 * Public types
 * --------------------------------------------------------------------- */

export interface BrandImportInput {
  /** The client's existing public website URL. */
  url: string;
}

export type BrandImportReason =
  | "ok"
  | "invalid_url"
  | "fetch_failed"
  | "timeout"
  | "html_parse_failed"
  | "empty_result";

export interface BrandScraped {
  url: string;
  title: string | null;
  description: string | null;
  ogImage: string | null;
  faviconUrl: string | null;
  themeColor: string | null;
  /** CSS custom-property values we found in inline <style> blocks. */
  cssPalette: string[];
  /** Palette measured from the og:image / hero via `extractPalette`. */
  imagePalette: string[];
  /** Unique font-family names, in document appearance order. */
  fontFamilies: string[];
  latencyMs: number;
}

export interface BrandThemeSuggestion {
  colors?: {
    primary?: string;
    accent?: string;
    bg?: string;
    fg?: string;
  };
  font?: {
    family?: string;
  };
}

export interface BrandImportResult {
  ok: boolean;
  reason: BrandImportReason;
  scraped: BrandScraped | null;
  themeSuggestion: BrandThemeSuggestion | null;
}

export interface BrandImportDeps {
  /** Injectable fetch for tests — never hits the network in unit tests. */
  fetchImpl?: typeof fetch;
  /** Injectable clock so latency numbers are deterministic in tests. */
  now?: () => number;
  /** Who initiated the scrape — drives analytics attribution. */
  user?: { id: string; role: string };
}

/* --------------------------------------------------------------------- *
 * Limits + constants (single source of truth; exported for tests)
 * --------------------------------------------------------------------- */

export const BRAND_SCRAPE_TIMEOUT_MS = 10_000;
export const BRAND_SCRAPE_MAX_BYTES = 2 * 1024 * 1024; // 2MB
export const BRAND_SCRAPE_MAX_REDIRECTS = 3;
export const BRAND_SCRAPE_USER_AGENT =
  "Instinct-BrandScraper/1.0 (+https://wolfpack-instinct.vercel.app/about)";

/* --------------------------------------------------------------------- *
 * Validation — URL shape + SSRF guard
 * --------------------------------------------------------------------- */

/**
 * IPv4 literal hosts we refuse. Pattern match is load-bearing: a host
 * like `127.1` (valid shorthand for 127.0.0.1) is not caught by a naive
 * "starts with 127." check, so we also normalise single-octet forms.
 *
 * Blocked:
 *   - 10.0.0.0/8
 *   - 127.0.0.0/8        (loopback)
 *   - 169.254.0.0/16     (link-local, includes EC2 metadata 169.254.169.254)
 *   - 172.16.0.0/12
 *   - 192.168.0.0/16
 *   - 0.0.0.0/8          (current network / "0")
 *   - 100.64.0.0/10      (CGNAT — generally not public)
 *   - 224.0.0.0/4        (multicast)
 *   - 240.0.0.0/4        (reserved)
 */
function isForbiddenIPv4(hostname: string): boolean {
  // Only consider hostnames that are entirely digits + dots. We DO NOT
  // resolve DNS here; a domain like "example.com" is allowed through.
  if (!/^\d+(\.\d+)*$/.test(hostname)) return false;
  const parts = hostname.split(".").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0 || p > 0xffffffff)) {
    return true; // malformed literal — refuse
  }
  // Normalise to 4 octets. IPv4 accepts 1-part (32-bit), 2-part (8+24),
  // 3-part (8+8+16), 4-part (8+8+8+8). We stay strict: anything other
  // than a dotted-quad is rejected so we never have to understand which
  // shorthand maps where. A "host" like `127.1` for loopback — refuse.
  if (parts.length !== 4) return true;
  const [a, b] = parts;
  if (parts.some((p) => p > 255)) return true;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

/**
 * IPv6 literal hosts we refuse. Browser URLs wrap v6 in brackets:
 * `https://[::1]/`. The URL parser strips the brackets for us — we
 * see plain `::1`, `fe80::1`, etc. We take the same belt-and-braces
 * approach as v4: reject anything that parses obviously as loopback /
 * link-local / unique-local.
 */
function isForbiddenIPv6(hostname: string): boolean {
  // Quick screen: v6 must contain at least one colon.
  if (!hostname.includes(":")) return false;
  const h = hostname.toLowerCase();
  if (h === "::" || h === "::1") return true; // unspecified + loopback
  if (h.startsWith("fe80:") || h.startsWith("fe80::")) return true; // link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // unique local
  if (h.startsWith("ff")) return true; // multicast
  // IPv4-mapped v6 addresses. The URL parser may normalise these into
  // either the dotted form `::ffff:127.0.0.1` OR the fully-expanded hex
  // form `::ffff:7f00:1`. We cover both — reject unconditionally when
  // the ::ffff: prefix is present, since the whole point of the mapped
  // form is to encode a v4 address and we already refuse every unsafe
  // v4 range.
  if (h.startsWith("::ffff:")) return true;
  return false;
}

/**
 * `parseBrandUrl` — strict URL validation gate.
 *
 * Returns a URL object or null with the typed failure reason. We split
 * this out so tests can exercise every refusal path directly without a
 * full scrape.
 */
export function parseBrandUrl(
  raw: string,
): { ok: true; url: URL } | { ok: false; reason: "invalid_url" } {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return { ok: false, reason: "invalid_url" };
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }
  // Allow http only for localhost-ish dev hosts; everything else must
  // be https. Mixed-content scrapes would also be suspect in production.
  const isHttps = u.protocol === "https:";
  const isHttp = u.protocol === "http:";
  if (!isHttps && !isHttp) return { ok: false, reason: "invalid_url" };
  const host = u.hostname.toLowerCase();
  const isLocalhostLike =
    host === "localhost" ||
    host === "localhost.localdomain" ||
    host.endsWith(".localhost");
  if (isHttp && !isLocalhostLike) return { ok: false, reason: "invalid_url" };
  if (isLocalhostLike) return { ok: true, url: u };
  // Node's URL parser keeps square brackets around IPv6 hostnames
  // (e.g. "[::1]"); strip them so the SSRF regex matches the raw form.
  const bareHost =
    host.startsWith("[") && host.endsWith("]")
      ? host.slice(1, -1)
      : host;
  if (isForbiddenIPv4(bareHost)) return { ok: false, reason: "invalid_url" };
  if (isForbiddenIPv6(bareHost)) return { ok: false, reason: "invalid_url" };
  return { ok: true, url: u };
}

/* --------------------------------------------------------------------- *
 * Fetch with redirect cap + byte cap + timeout
 * --------------------------------------------------------------------- */

interface SafeFetchResult {
  finalUrl: URL;
  html: string;
  headers: Headers;
}

async function safeFetchHtml(
  startUrl: URL,
  deps: BrandImportDeps,
): Promise<
  | { ok: true; result: SafeFetchResult }
  | { ok: false; reason: "fetch_failed" | "timeout" | "invalid_url" }
> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  let current = startUrl;
  let hops = 0;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRAND_SCRAPE_TIMEOUT_MS);
  try {
    while (true) {
      // Belt-and-braces SSRF gate at every hop. parseBrandUrl validated
      // the entry URL and every redirect target; we additionally insist on
      // https:// here so any future caller that constructs a URL outside
      // parseBrandUrl can never reach `fetch()` over a non-TLS scheme
      // (CodeQL: js/request-forgery).
      const safeUrl = parseBrandUrl(current.toString());
      if (!safeUrl.ok) return { ok: false, reason: "invalid_url" };
      if (
        safeUrl.url.protocol !== "https:" &&
        !(
          safeUrl.url.hostname === "localhost" ||
          safeUrl.url.hostname.endsWith(".localhost")
        )
      ) {
        return { ok: false, reason: "invalid_url" };
      }
      const res = await fetchImpl(safeUrl.url.toString(), {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": BRAND_SCRAPE_USER_AGENT,
          Accept: "text/html,application/xhtml+xml",
        },
      });
      // 3xx → check Location + re-validate SSRF on every hop.
      if (res.status >= 300 && res.status < 400) {
        if (hops >= BRAND_SCRAPE_MAX_REDIRECTS) {
          return { ok: false, reason: "fetch_failed" };
        }
        const loc = res.headers.get("location");
        if (!loc) return { ok: false, reason: "fetch_failed" };
        let next: URL;
        try {
          next = new URL(loc, current);
        } catch {
          return { ok: false, reason: "fetch_failed" };
        }
        const validated = parseBrandUrl(next.toString());
        if (!validated.ok) return { ok: false, reason: "invalid_url" };
        current = validated.url;
        hops++;
        continue;
      }
      if (!res.ok) {
        return { ok: false, reason: "fetch_failed" };
      }
      // Read up to BRAND_SCRAPE_MAX_BYTES. If we can, stream; otherwise
      // fall back to `.text()` which the polyfills in tests provide. The
      // truncation guarantee is asserted either way: after reading, if
      // the resulting string is longer than the cap we slice it.
      let html: string;
      try {
        const body = res.body;
        if (body && typeof (body as ReadableStream).getReader === "function") {
          const reader = (body as ReadableStream<Uint8Array>).getReader();
          const chunks: Uint8Array[] = [];
          let total = 0;
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (!value) continue;
            total += value.byteLength;
            chunks.push(value);
            if (total >= BRAND_SCRAPE_MAX_BYTES) {
              try {
                await reader.cancel();
              } catch {
                /* non-fatal */
              }
              break;
            }
          }
          // Concatenate and decode
          const merged = new Uint8Array(total);
          let off = 0;
          for (const c of chunks) {
            merged.set(c.subarray(0, Math.min(c.byteLength, merged.byteLength - off)), off);
            off += c.byteLength;
            if (off >= merged.byteLength) break;
          }
          const slice = merged.subarray(0, Math.min(merged.byteLength, BRAND_SCRAPE_MAX_BYTES));
          html = new TextDecoder("utf-8", { fatal: false }).decode(slice);
        } else {
          html = await res.text();
        }
      } catch {
        return { ok: false, reason: "fetch_failed" };
      }
      if (html.length > BRAND_SCRAPE_MAX_BYTES) {
        html = html.slice(0, BRAND_SCRAPE_MAX_BYTES);
      }
      return {
        ok: true,
        result: { finalUrl: current, html, headers: res.headers },
      };
    }
  } catch (err) {
    const msg = (err as Error)?.name ?? "";
    if (msg === "AbortError") return { ok: false, reason: "timeout" };
    return { ok: false, reason: "fetch_failed" };
  } finally {
    clearTimeout(timer);
  }
}

/* --------------------------------------------------------------------- *
 * HTML parsers (regex-based; no DOM dep needed)
 * --------------------------------------------------------------------- */

/**
 * Extract a meta-tag content value by attribute/name. Case-insensitive.
 * Example: `readMeta(html, "property", "og:image")`.
 */
function readMeta(
  html: string,
  attr: "name" | "property",
  key: string,
): string | null {
  // Two orderings: attr= key first or content= first. A single regex
  // with alternation covers both without needing a real parser.
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const r1 = new RegExp(
    `<meta[^>]*\\b${attr}=["']${escapedKey}["'][^>]*\\bcontent=["']([^"']*)["']`,
    "i",
  );
  const r2 = new RegExp(
    `<meta[^>]*\\bcontent=["']([^"']*)["'][^>]*\\b${attr}=["']${escapedKey}["']`,
    "i",
  );
  const m = r1.exec(html) ?? r2.exec(html);
  return m ? m[1] : null;
}

function readTitle(html: string): string | null {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? m[1].trim() || null : null;
}

function readFavicon(html: string): string | null {
  // Prefer apple-touch-icon (always 180x180 PNG) over favicon.ico, then
  // any generic icon relation. We pick the first match in declared order.
  const relOptions = ["apple-touch-icon", "icon", "shortcut icon"];
  for (const rel of relOptions) {
    const r = new RegExp(
      `<link[^>]*\\brel=["'](?:${rel}|[^"']*\\s${rel})["'][^>]*\\bhref=["']([^"']+)["']`,
      "i",
    );
    const r2 = new RegExp(
      `<link[^>]*\\bhref=["']([^"']+)["'][^>]*\\brel=["'](?:${rel}|[^"']*\\s${rel})["']`,
      "i",
    );
    const m = r.exec(html) ?? r2.exec(html);
    if (m) return m[1];
  }
  return null;
}

/**
 * Pull every inline <style> block. We ignore remote stylesheet fetches
 * in v1 — they balloon latency budget, and modern sites increasingly
 * emit brand tokens inline in the `<head>` via CSS-in-JS or server-side
 * token injection. Remote CSS follow-up is out of scope here.
 */
function readInlineStyles(html: string): string {
  const out: string[] = [];
  const re = /<style[^>]*>([\s\S]*?)<\/style>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    out.push(m[1]);
  }
  return out.join("\n");
}

/**
 * Extract CSS custom-property values that match the modern brand-token
 * convention: `--primary`, `--accent`, `--bg`, `--fg` OR the prefixed
 * `--color-primary`, `--color-accent`, etc. We normalise hex to lower
 * case and de-duplicate while preserving declaration order.
 */
export function extractCssPalette(css: string): string[] {
  const found: string[] = [];
  const seen = new Set<string>();
  const keys = [
    "primary",
    "accent",
    "bg",
    "background",
    "fg",
    "foreground",
    "text",
    "color-primary",
    "color-accent",
    "color-bg",
    "color-background",
    "color-fg",
    "color-foreground",
    "color-text",
    "brand",
    "brand-primary",
    "brand-accent",
  ];
  for (const k of keys) {
    const re = new RegExp(`--${k}\\s*:\\s*([^;\\n}]+)[;}\\n]`, "gi");
    let m: RegExpExecArray | null;
    while ((m = re.exec(css)) !== null) {
      const raw = m[1].trim();
      // Match #rgb, #rrggbb, #rrggbbaa (we normalise to 6-digit hex)
      const hex = /#([0-9a-f]{3,8})/i.exec(raw);
      if (!hex) continue;
      const h = hex[1].toLowerCase();
      let norm: string | null = null;
      if (h.length === 3) {
        norm = `#${h[0]}${h[0]}${h[1]}${h[1]}${h[2]}${h[2]}`;
      } else if (h.length === 6) {
        norm = `#${h}`;
      } else if (h.length === 8) {
        norm = `#${h.slice(0, 6)}`;
      }
      if (!norm) continue;
      if (seen.has(norm)) continue;
      seen.add(norm);
      found.push(norm);
    }
  }
  return found;
}

/**
 * Extract font-family declarations — the body rule wins priority in the
 * return order. We walk every `font-family: ...` in the CSS, strip
 * quotes + generic fallbacks (`sans-serif`, `serif`, etc.), and return
 * unique named families preserving first-appearance order.
 *
 * Callers treat index 0 as the brand's primary font.
 */
export function extractFontFamilies(css: string): string[] {
  const GENERICS = new Set([
    "serif",
    "sans-serif",
    "monospace",
    "cursive",
    "fantasy",
    "system-ui",
    "ui-serif",
    "ui-sans-serif",
    "ui-monospace",
    "ui-rounded",
    "math",
    "emoji",
    "fangsong",
    "inherit",
    "initial",
    "unset",
    "-apple-system",
    "blinkmacsystemfont",
    "apple-system",
  ]);
  const out: string[] = [];
  const seen = new Set<string>();
  // Priority: body { font-family } first so brand body font wins order
  const bodyMatches = [
    ...css.matchAll(/\bbody\s*\{[^}]*font-family\s*:\s*([^;}\n]+)/gi),
    ...css.matchAll(/:root\s*\{[^}]*font-family\s*:\s*([^;}\n]+)/gi),
  ];
  const generic = [...css.matchAll(/font-family\s*:\s*([^;}\n]+)/gi)];
  const all = [...bodyMatches, ...generic];
  for (const match of all) {
    const raw = match[1];
    const families = raw
      .split(",")
      .map((f) => f.trim().replace(/^['"]|['"]$/g, "").trim());
    for (const f of families) {
      if (!f) continue;
      const lc = f.toLowerCase();
      if (GENERICS.has(lc)) continue;
      if (seen.has(lc)) continue;
      seen.add(lc);
      out.push(f);
    }
  }
  return out;
}

/**
 * Absolute URL resolution — every href/src we lift off the page is
 * normalised against the scraped page's own URL so the caller never
 * has to care whether the source page used relative, protocol-relative,
 * or absolute addressing.
 */
export function resolveHref(
  href: string | null,
  base: URL,
): string | null {
  if (!href) return null;
  try {
    return new URL(href, base).toString();
  } catch {
    return null;
  }
}

/* --------------------------------------------------------------------- *
 * og:image palette — reuse the in-repo k-means extractor
 * --------------------------------------------------------------------- */

async function tryImagePalette(
  imageUrl: string,
  deps: BrandImportDeps,
): Promise<string[]> {
  const fetchImpl = deps.fetchImpl ?? fetch;
  // SSRF guard: og:image URLs come from scraped HTML — attacker-controllable.
  // Run them through the same parseBrandUrl gate as the page fetch so they
  // can never reach internal hosts (CodeQL: js/request-forgery).
  const parsed = parseBrandUrl(imageUrl);
  if (!parsed.ok) return [];
  if (
    parsed.url.protocol !== "https:" &&
    !(
      parsed.url.hostname === "localhost" ||
      parsed.url.hostname.endsWith(".localhost")
    )
  ) {
    return [];
  }
  try {
    const res = await fetchImpl(parsed.url.toString(), {
      method: "GET",
      headers: { "User-Agent": BRAND_SCRAPE_USER_AGENT },
    });
    if (!res.ok) return [];
    const buf = new Uint8Array(await res.arrayBuffer());
    // Cap at 1MB — a hero image we can't decode in under that is not a
    // hero image worth palette-extracting from.
    if (buf.byteLength > 1024 * 1024) return [];
    const palette = extractPalette(buf, 5);
    return palette.swatches;
  } catch {
    return [];
  }
}

/* --------------------------------------------------------------------- *
 * Map scraped data → SiteTheme suggestion
 * --------------------------------------------------------------------- */

function buildThemeSuggestion(scraped: BrandScraped): BrandThemeSuggestion {
  // Preference order: CSS palette (authoritative, set by the site),
  // then theme-color meta, then image-extracted palette.
  const colors: Record<string, string> = {};
  const cssOrder = [...scraped.cssPalette];
  const image = scraped.imagePalette;
  const primary =
    cssOrder[0] ??
    scraped.themeColor ??
    image[0] ??
    null;
  const accent = cssOrder[1] ?? image[1] ?? null;
  const bg = cssOrder[2] ?? image[2] ?? null;
  const fg = cssOrder[3] ?? image[3] ?? null;
  if (primary) colors.primary = primary;
  if (accent && accent !== primary) colors.accent = accent;
  if (bg) colors.bg = bg;
  if (fg) colors.fg = fg;

  const suggestion: BrandThemeSuggestion = {};
  if (Object.keys(colors).length > 0) suggestion.colors = colors;
  if (scraped.fontFamilies[0]) {
    suggestion.font = { family: scraped.fontFamilies[0] };
  }
  return suggestion;
}

/* --------------------------------------------------------------------- *
 * Entry point
 * --------------------------------------------------------------------- */

/**
 * `importFromBrandUrl` — fetch, parse, map, return. Never throws.
 * Every failure is typed + analytics-emitted. Calling routes serialise
 * the result directly.
 */
export async function importFromBrandUrl(
  input: BrandImportInput,
  deps: BrandImportDeps = {},
): Promise<BrandImportResult> {
  const now = deps.now ?? (() => Date.now());
  const startedAt = now();
  const userId = deps.user?.id ?? "";
  const userRole = deps.user?.role ?? "";

  // Phase 0: URL validation — cheapest rejection. Fires analytics
  // (requested/failed) from here so we track attempts that were bad-URL
  // rather than silently dropping them.
  const parsed = parseBrandUrl(input.url);
  if (!parsed.ok) {
    if (userId) {
      trackEvent("brand_import_requested", userId, userRole, {
        url_host: safeHost(input.url),
      });
      trackEvent("brand_import_failed", userId, userRole, {
        url_host: safeHost(input.url),
        reason: "invalid_url",
      });
    }
    return {
      ok: false,
      reason: "invalid_url",
      scraped: null,
      themeSuggestion: null,
    };
  }
  const urlObj = parsed.url;
  const host = urlObj.hostname.toLowerCase();

  if (userId) {
    trackEvent("brand_import_requested", userId, userRole, { url_host: host });
  }

  const fetched = await safeFetchHtml(urlObj, deps);
  if (!fetched.ok) {
    if (userId) {
      trackEvent("brand_import_failed", userId, userRole, {
        url_host: host,
        reason: fetched.reason,
      });
    }
    // invalid_url-via-redirect reports as invalid_url; fetch_failed +
    // timeout pass through unchanged.
    const reason: BrandImportReason =
      fetched.reason === "invalid_url" ? "invalid_url" : fetched.reason;
    return { ok: false, reason, scraped: null, themeSuggestion: null };
  }

  const { html, finalUrl } = fetched.result;
  if (!html || html.length === 0) {
    if (userId) {
      trackEvent("brand_import_failed", userId, userRole, {
        url_host: host,
        reason: "html_parse_failed",
      });
    }
    return {
      ok: false,
      reason: "html_parse_failed",
      scraped: null,
      themeSuggestion: null,
    };
  }

  // Phase 2: parse the HTML + CSS. Everything regex — no DOM dep.
  const title = readTitle(html);
  const description = readMeta(html, "name", "description");
  const ogImageRaw = readMeta(html, "property", "og:image");
  const ogImage = resolveHref(ogImageRaw, finalUrl);
  const faviconRaw = readFavicon(html);
  const faviconUrl = resolveHref(faviconRaw, finalUrl);
  const themeColor = readMeta(html, "name", "theme-color");
  const css = readInlineStyles(html);
  const cssPalette = extractCssPalette(css);
  const fontFamilies = extractFontFamilies(css);

  let imagePalette: string[] = [];
  // Only fetch the hero image when a palette was NOT already extracted
  // from CSS — skips a second network hop when the site already gives
  // us brand tokens outright.
  if (ogImage && cssPalette.length < 2) {
    imagePalette = await tryImagePalette(ogImage, deps);
  }

  const scraped: BrandScraped = {
    url: finalUrl.toString(),
    title,
    description,
    ogImage,
    faviconUrl,
    themeColor,
    cssPalette,
    imagePalette,
    fontFamilies,
    latencyMs: now() - startedAt,
  };

  const themeSuggestion = buildThemeSuggestion(scraped);
  const haveSomething =
    (themeSuggestion.colors &&
      Object.keys(themeSuggestion.colors).length > 0) ||
    !!themeSuggestion.font?.family ||
    !!scraped.faviconUrl ||
    !!scraped.ogImage ||
    !!scraped.title;
  if (!haveSomething) {
    if (userId) {
      trackEvent("brand_import_failed", userId, userRole, {
        url_host: host,
        reason: "empty_result",
      });
    }
    return {
      ok: false,
      reason: "empty_result",
      scraped,
      themeSuggestion: null,
    };
  }

  if (userId) {
    trackEvent("brand_import_completed", userId, userRole, {
      url_host: host,
      palette_size: cssPalette.length + imagePalette.length,
      font_count: fontFamilies.length,
      latency_ms: scraped.latencyMs,
      had_og_image: !!ogImage,
    });
  }

  return {
    ok: true,
    reason: "ok",
    scraped,
    themeSuggestion,
  };
}

/**
 * Safe hostname extract for analytics — never throws, never leaks the
 * full URL (which could contain query-string PII). Unknown → "unknown".
 */
export function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return "unknown";
  }
}

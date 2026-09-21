/**
 * Forcefield for the Web - client + tooling fingerprint.
 *
 * The base classifier answers "welcome / trap / suspicious / normal." This adds
 * RESOLUTION: what KIND of client is this, and if it is automation, WHICH tool?
 * A marketing site's hostile traffic is mostly background scanning, and every one
 * of those scanners announces itself in its User-Agent or header shape - so
 * naming the tool ("python-requests", "sqlmap", "Nmap") and giving each a finer
 * signature turns a pile of "unidentified automation" into distinguishable actors
 * the operator board can cluster and attribute.
 *
 * PURE + EDGE-SAFE: reads a UA string and the set of present header names, returns
 * plain data. No I/O. Deterministic. Drops into a middleware alongside classify.
 */

export type ClientType =
  | "browser" // a real browser (has the browser header trinity)
  | "known_crawler" // a self-declared, well-known crawler UA
  | "scripted_library" // an HTTP client library (requests, curl, Go net/http, ...)
  | "scanner" // a recon / vuln / attack tool (nmap, sqlmap, nuclei, ...)
  | "headless" // an automated browser (HeadlessChrome, Puppeteer, Playwright, ...)
  | "unknown"; // automation with no recognizable marker

/** One tool signature: [displayName, lowercased-substring, type]. */
export type ToolSignature = readonly [string, string, ClientType];

/** The BUNDLED default tool signatures - the fail-open fallback baked into every
 *  site so detection works even if the central ruleset can't be fetched. The live
 *  set is served centrally (see ruleset.ts) so new scanners can be added ONCE and
 *  every connected site picks them up without a redeploy. Most-specific first: a
 *  scanner marker outranks a generic library marker (sqlmap is built on Python,
 *  but it is a scanner). */
export const DEFAULT_TOOL_SIGNATURES: readonly ToolSignature[] = [
  // Recon / vuln / attack tooling - the strongest hostile tell.
  ["sqlmap", "sqlmap", "scanner"],
  ["Nikto", "nikto", "scanner"],
  ["Nmap", "nmap", "scanner"],
  ["masscan", "masscan", "scanner"],
  ["zgrab", "zgrab", "scanner"],
  ["Nuclei", "nuclei", "scanner"],
  ["WPScan", "wpscan", "scanner"],
  ["gobuster", "gobuster", "scanner"],
  ["feroxbuster", "feroxbuster", "scanner"],
  ["dirbuster", "dirbuster", "scanner"],
  ["ffuf", "ffuf", "scanner"],
  ["Acunetix", "acunetix", "scanner"],
  ["Nessus", "nessus", "scanner"],
  ["Censys", "censys", "scanner"],
  ["Shodan", "shodan", "scanner"],
  ["zmap", "zmap", "scanner"],
  // Headless / automated browsers.
  ["HeadlessChrome", "headlesschrome", "headless"],
  ["PhantomJS", "phantomjs", "headless"],
  ["Puppeteer", "puppeteer", "headless"],
  ["Playwright", "playwright", "headless"],
  ["Selenium", "selenium", "headless"],
  ["Electron", "electron", "headless"],
  // Scripted HTTP client libraries - automation, not a browser.
  ["python-requests", "python-requests", "scripted_library"],
  ["aiohttp", "aiohttp", "scripted_library"],
  ["httpx", "python-httpx", "scripted_library"],
  ["urllib", "python-urllib", "scripted_library"],
  ["Scrapy", "scrapy", "scripted_library"],
  ["Go-http-client", "go-http-client", "scripted_library"],
  ["node-fetch", "node-fetch", "scripted_library"],
  ["axios", "axios", "scripted_library"],
  ["okhttp", "okhttp", "scripted_library"],
  ["Java", "java/", "scripted_library"],
  ["Apache-HttpClient", "apache-httpclient", "scripted_library"],
  ["libwww-perl", "libwww-perl", "scripted_library"],
  ["Guzzle", "guzzlehttp", "scripted_library"],
  ["curl", "curl/", "scripted_library"],
  ["Wget", "wget", "scripted_library"],
  ["HTTPie", "httpie", "scripted_library"],
];

/** Well-known crawlers (welcome-lane candidates). Kept distinct from the site's
 *  allowlist: this only labels the client type, it does not grant the lane. */
const KNOWN_CRAWLER_MARKERS = [
  "googlebot", "bingbot", "duckduckbot", "yandexbot", "baiduspider", "applebot",
  "gptbot", "oai-searchbot", "chatgpt-user", "claudebot", "perplexitybot",
  "amazonbot", "bytespider", "facebookexternalhit", "meta-externalagent",
];

/** The header trinity a mainstream browser sends together. Their joint presence
 *  is a (weak, spoofable) browser signal; their ABSENCE on a self-declared
 *  browser is a stronger bot tell. */
const BROWSER_HEADER_HINTS = ["accept", "accept-language", "accept-encoding"];

export interface ClientFingerprint {
  clientType: ClientType;
  /** The specific tool name when recognized (e.g. "sqlmap", "curl"). */
  tool?: string;
  /** True when the UA self-declares a browser but the request lacks the header
   *  shape a real browser sends - a spoofed-browser tell. */
  headerMismatch: boolean;
}

function lc(s: string): string {
  return (s ?? "").toLowerCase();
}

/**
 * Classify the client from its User-Agent and the set of present header names.
 * Deterministic and ordered: named tool -> known crawler -> browser-vs-headers ->
 * unknown. `headerNames` is the lowercased list of header names on the request.
 */
export function classifyClient(
  userAgent: string,
  headerNames: readonly string[] = [],
  signatures: readonly ToolSignature[] = DEFAULT_TOOL_SIGNATURES,
): ClientFingerprint {
  const ua = lc(userAgent);
  const names = new Set(headerNames.map(lc));

  // 1. A named tool is the highest-resolution signal. Signatures are injected so
  //    the live set can come from the central ruleset; falls back to the bundled
  //    defaults when none is provided.
  for (const [display, marker, type] of signatures) {
    if (ua.includes(marker)) return { clientType: type, tool: display, headerMismatch: false };
  }

  // 2. A recognized crawler.
  if (KNOWN_CRAWLER_MARKERS.some((m) => ua.includes(m))) {
    return { clientType: "known_crawler", headerMismatch: false };
  }

  // 3. Browser-vs-headers. A real browser claims "Mozilla/" AND sends the header
  //    trinity. Claiming a browser without the headers is a spoof tell.
  const claimsBrowser = ua.includes("mozilla/");
  const hasBrowserHeaders = BROWSER_HEADER_HINTS.every((h) => names.has(h));
  if (claimsBrowser) {
    return { clientType: hasBrowserHeaders ? "browser" : "unknown", headerMismatch: !hasBrowserHeaders };
  }

  // 4. Automation with no marker we recognize.
  return { clientType: ua.length === 0 ? "unknown" : "unknown", headerMismatch: false };
}

/**
 * A compact, stable signature of the request's header ORDER + presence. Bots and
 * libraries emit a characteristic, often minimal, header set in a fixed order
 * that differs from a browser's - a fingerprint that survives UA spoofing. FNV-1a
 * over the joined lowercased names; edge-safe, non-PII (names only, no values).
 */
export function headerSignature(headerNames: readonly string[]): string {
  const s = headerNames.map(lc).join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

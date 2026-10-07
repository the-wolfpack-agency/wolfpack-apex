/**
 * AI RED-TEAM corpus: novel attack variants discovered by attacking our OWN engine
 * with AI in the factory, that we have since CONFIRMED the deterministic engine
 * blocks. Once a slip is found and a rule welds it shut, the case lands here as a
 * permanent regression: the gap, once closed, stays closed.
 *
 * This is the committed OUTPUT of scripts/forcefield-ai-redteam.ts. The generator
 * runs offline (it is the only part that touches a model); everything here is
 * static data, so CI and the runtime stay model-free and the AI-containment
 * boundary holds. New confirmed-blocked cases are appended over time; a case that
 * the engine does NOT yet block is a SLIP and belongs in the slip report as a rule
 * to write, never here.
 *
 * The benign lookalikes matter as much as the attacks: AI is good at inventing
 * payload-SHAPED traffic that is actually legitimate (a blog post about SQL
 * injection, a product filter named "select"), and those must never be blocked.
 */
import type { GapCase } from "./gap-metric";

const SCANNER_HEADERS = ["host", "user-agent"];
const BROWSER_HEADERS = ["host", "user-agent", "accept", "accept-language", "accept-encoding"];
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";

/** A hostile case the engine is confirmed to block, carried by its raw URL. */
const attack = (name: string, rawUrl: string, ua = BROWSER_UA, headerNames = BROWSER_HEADERS): GapCase => ({
  name,
  input: { path: rawUrl.split("?")[0], rawUrl, method: "GET", userAgent: ua, headerNames },
  intendedHostile: true,
});

/** A benign case that LOOKS hostile but must never be blocked (false-positive guard). */
const lookalike = (name: string, rawUrl: string): GapCase => ({
  name,
  input: { path: rawUrl.split("?")[0], rawUrl, method: "GET", userAgent: BROWSER_UA, headerNames: BROWSER_HEADERS },
  intendedHostile: false,
});

export const AI_REDTEAM_CORPUS: readonly GapCase[] = [
  // --- Obfuscated injection payloads (AI loves encoding tricks) ----------------
  attack("double-encoded path traversal", "/files?p=%252e%252e%252f%252e%252e%252fetc/passwd"),
  attack("stacked-dot path traversal", "/download?f=....//....//etc/passwd"),
  attack("mixed-case + plus-separated SQLi", "/search?q=UniOn+SeLeCt+1,2,3--"),
  attack("newline-separated SQLi", "/item?id=1%0aUNION%0aSELECT%0apassword"),
  attack("boolean SQLi tautology", "/login?u=admin'+OR+'1'='1"),
  attack("url-encoded reflected XSS", "/q?s=%3Cscript%3Ealert(document.cookie)%3C/script%3E"),
  attack("event-handler XSS", "/profile?name=x%22+onerror%3Dalert(1)+y"),
  attack("protocol-relative open redirect", "/go?next=%2f%2fevil.example.com/phish"),

  // --- Scanner / exploit tooling with less-common UA strings -------------------
  attack("sqlmap embedded in a longer UA", "/", "python-requests/2.31 sqlmap/1.8-dev", SCANNER_HEADERS),
  attack("nuclei version variant", "/", "Nuclei/3.1.0 (projectdiscovery.io)", SCANNER_HEADERS),
  attack("wpscan minor variant", "/", "WPScan v3.8.25 (https://wpscan.com/)", SCANNER_HEADERS),

  // --- Benign lookalikes: payload-SHAPED but legitimate (must NOT be blocked) ---
  lookalike("blog post about preventing SQL injection", "/blog/how-to-prevent-sql-injection-in-node"),
  lookalike("product filter literally named select", "/shop?category=select-series&sort=price"),
  lookalike("docs page mentioning xss defenses", "/docs/security/cross-site-scripting-protection"),
];

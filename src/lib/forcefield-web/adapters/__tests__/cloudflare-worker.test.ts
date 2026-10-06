/** @jest-environment node */
/**
 * Forcefield Cloudflare Worker adapter - the pure decision core.
 *
 * The adapter must detect exactly what the Next middleware detects, because both
 * call the same engine; these tests pin that the Worker's request-mapping feeds
 * the engine correctly, against the REAL bundled ruleset (no mocks of the engine).
 */
import { requestSignals, evaluateRequest } from "../cloudflare-worker";
import { DEFAULT_RULESET } from "../../ruleset";

const AT = 1_700_000_000_000; // fixed nowMs for determinism

function req(url: string, headers: Record<string, string> = {}): Request {
  return new Request(url, { headers });
}

describe("requestSignals", () => {
  it("lowercases header names and pulls UA / country / client IP from edge headers", () => {
    const s = requestSignals(
      req("https://site.example/path?q=1", {
        "User-Agent": "Mozilla/5.0",
        "CF-IPCountry": "AE",
        "CF-Connecting-IP": "203.0.113.9, 10.0.0.1",
        "Accept": "text/html",
      }),
      AT,
    );
    expect(s.userAgent).toBe("Mozilla/5.0");
    expect(s.country).toBe("AE");
    expect(s.ip).toBe("203.0.113.9"); // first hop only
    expect(s.headerNames).toContain("user-agent");
    expect(s.headerNames.every((h) => h === h.toLowerCase())).toBe(true);
    expect(s.url.pathname).toBe("/path");
  });
});

describe("evaluateRequest (reuses the real engine + bundled ruleset)", () => {
  it("BLOCKS a request that hits an invisible honeypot (decoy trip)", () => {
    const trap = DEFAULT_RULESET.trapPaths[0];
    const s = requestSignals(req(`https://site.example${trap}`, { "User-Agent": "curl/8" }), AT);
    const { verdict } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(true);
    expect(verdict.reasonKind).toBe("decoy");
  });

  it("BLOCKS a request carrying an injection payload in the query", () => {
    const s = requestSignals(req("https://site.example/search?q=%2e%2e%2f%2e%2e%2fetc%2fpasswd", { "User-Agent": "x" }), AT);
    const { verdict } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(true);
    expect(verdict.reasonKind).toBe("payload");
    expect(verdict.attack).toBe("path_traversal");
  });

  it("does NOT block a normal browser page view, and produces an observation", () => {
    const s = requestSignals(
      req("https://site.example/", {
        "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Sec-Fetch-Dest": "document",
      }),
      AT,
    );
    const { verdict, observation } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(false);
    expect(observation).not.toBeNull();
    expect(observation?.path).toBe("/");
  });

  it("is safe-by-default: a bare recon probe is recorded, not blocked", () => {
    // A sensitive path with no payload and no attack-tool UA is report-only.
    const s = requestSignals(req("https://site.example/.env", { "User-Agent": "Mozilla/5.0" }), AT);
    const { verdict } = evaluateRequest("beforeutrade", s, DEFAULT_RULESET);
    expect(verdict.block).toBe(false); // precision-first: a probe hint is not proof
  });
});

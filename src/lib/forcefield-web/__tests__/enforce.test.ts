import { decideEnforcement, detectPayload } from "@/lib/forcefield-web/enforce";
import { operatorFingerprint } from "@/lib/forcefield-web/fingerprint";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

const R = DEFAULT_RULESET;
// What a real Chrome 120 navigation sends (Fetch Metadata included: a Chrome claim
// without it is a spoofed browser, see fingerprint.ts).
const base = {
  method: "GET",
  headerNames: ["host", "user-agent", "accept", "accept-language", "accept-encoding", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-dest", "sec-fetch-user"],
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0 Safari/537.36",
};

describe("decideEnforcement - blocks proven-hostile requests only", () => {
  it("BLOCKS a decoy trip (highest-confidence bot signal)", () => {
    const d = decideEnforcement({ ...base, path: "/_ff/records", userAgent: "x" }, R);
    expect(d.block).toBe(true);
    expect(d.reasonKind).toBe("decoy");
  });

  it("BLOCKS a named attack tool (sqlmap)", () => {
    const d = decideEnforcement({ ...base, path: "/search", userAgent: "sqlmap/1.7" }, R);
    expect(d.block).toBe(true);
    expect(d.reasonKind).toBe("attack_tool");
    expect(d.reason).toMatch(/sqlmap/);
  });

  it("BLOCKS a path-traversal payload", () => {
    const d = decideEnforcement({ ...base, path: "/wp-content/plugins/x/dompdf/dompdf.php", rawUrl: "/wp-content/plugins/x/dompdf/dompdf.php?p=../../../../etc/passwd" }, R);
    expect(d.block).toBe(true);
    expect(d.reasonKind).toBe("payload");
    expect(d.attack).toBe("path_traversal");
  });

  it("BLOCKS a SQL-injection payload", () => {
    const d = decideEnforcement({ ...base, path: "/wp-admin/admin-ajax.php", rawUrl: "/wp-admin/admin-ajax.php?id=1%20UNION%20SELECT%20password%20FROM%20users" }, R);
    expect(d.block).toBe(true);
    expect(d.attack).toBe("sql_injection");
  });

  it("BLOCKS an XSS payload", () => {
    const d = decideEnforcement({ ...base, path: "/search", rawUrl: "/search?q=<script>alert(1)</script>" }, R);
    expect(d.block).toBe(true);
    expect(d.attack).toBe("xss");
  });

  it("BLOCKS an open-redirect payload", () => {
    const d = decideEnforcement({ ...base, path: "/out", rawUrl: "/out?next=//evil.example.com" }, R);
    expect(d.block).toBe(true);
    expect(d.attack).toBe("open_redirect");
  });

  it("BLOCKS a blocked fingerprint for a NON-browser client (a scripted scraper)", () => {
    const d = decideEnforcement(
      { ...base, path: "/", userAgent: "python-requests/2.31", headerNames: ["host", "user-agent"], fingerprint: "abcd1234" },
      R, { blockedFingerprints: ["abcd1234"] },
    );
    expect(d.block).toBe(true);
    expect(d.reasonKind).toBe("blocked_fingerprint");
  });

  it("a spoofed browser (Chrome UA, no Fetch Metadata) loses the browser exemption: its blocked fingerprint is enforced", () => {
    const spoof = { ...base, headerNames: ["host", "user-agent", "accept", "accept-language", "accept-encoding"] };
    const d = decideEnforcement({ ...spoof, path: "/", fingerprint: "abcd1234" }, R, { blockedFingerprints: ["abcd1234"] });
    expect(d).toMatchObject({ block: true, reasonKind: "blocked_fingerprint" });
  });

  it("SAFETY: does NOT block a blocked fingerprint when the client is a real browser", () => {
    // Even if a real user's header shape collides with a blocked fingerprint,
    // a browser is never turned away - the block reaches only automation.
    const d = decideEnforcement({ ...base, path: "/", fingerprint: "abcd1234" }, R, { blockedFingerprints: ["abcd1234"] });
    expect(d.block).toBe(false);
  });
});

describe("decideEnforcement - NEVER blocks legitimate traffic (no false positives)", () => {
  it("ALLOWS a normal human browser navigation", () => {
    expect(decideEnforcement({ ...base, path: "/pricing", rawUrl: "/pricing" }, R).block).toBe(false);
  });

  it("ALLOWS a welcomed, allowlisted crawler even on an odd path", () => {
    expect(decideEnforcement({ ...base, path: "/sitemap.xml", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)" }, R).block).toBe(false);
  });

  it("ALLOWS a welcomed crawler that would otherwise look scripted", () => {
    // A known agent wins over the scanner/tool heuristics - the welcome lane.
    expect(decideEnforcement({ ...base, path: "/", userAgent: "GPTBot" }, R).block).toBe(false);
  });

  it("does NOT block a weak 'suspicious' self-declared bot (report-only, not proof)", () => {
    expect(decideEnforcement({ ...base, path: "/", userAgent: "some-random-bot/1.0" }, R).block).toBe(false);
  });

  it("does NOT block a bare recon probe with no payload (recon is reported, not blocked)", () => {
    expect(decideEnforcement({ ...base, path: "/wp-login.php", rawUrl: "/wp-login.php" }, R).block).toBe(false);
  });

  it("does NOT block a legit URL that merely contains '..' in a value but not as traversal", () => {
    expect(decideEnforcement({ ...base, path: "/articles/the..end", rawUrl: "/articles/the..end" }, R).block).toBe(false);
  });

  it("does NOT block a normal redirect to a same-site relative path", () => {
    expect(decideEnforcement({ ...base, path: "/login", rawUrl: "/login?next=/dashboard" }, R).block).toBe(false);
  });

  it("does NOT block when a fingerprint is present but not on the blocked list", () => {
    expect(decideEnforcement({ ...base, path: "/", userAgent: "curl/8", headerNames: ["host"], fingerprint: "safe999" }, R, { blockedFingerprints: ["bad000"] }).block).toBe(false);
  });
});

describe("decideEnforcement - fingerprint precision (tool-bound, no header-shape collisions)", () => {
  const H = ["host", "user-agent", "accept-encoding"]; // minimal, non-browser
  // The blocked operator's fingerprint: a python-requests client with header shape H.
  const blockedFp = operatorFingerprint(H, "python-requests", "scripted_library");

  it("BLOCKS the exact tool+header-shape the admin blocked", () => {
    const d = decideEnforcement(
      { ...base, path: "/", userAgent: "python-requests/2.31", headerNames: H },
      R, { blockedFingerprints: [blockedFp] },
    );
    expect(d.block).toBe(true);
    expect(d.reasonKind).toBe("blocked_fingerprint");
  });

  it("does NOT block a DIFFERENT tool that merely shares the header shape (the precision win)", () => {
    // Same headers H, but curl instead of python-requests -> different fingerprint -> allowed.
    const d = decideEnforcement(
      { ...base, path: "/", userAgent: "curl/8.4", headerNames: H },
      R, { blockedFingerprints: [blockedFp] },
    );
    expect(d.block).toBe(false);
  });

  it("does NOT block a real browser even if its fingerprint were on the list (safety gate holds)", () => {
    const browserFp = operatorFingerprint(base.headerNames, undefined, "browser");
    const d = decideEnforcement({ ...base, path: "/" }, R, { blockedFingerprints: [browserFp] });
    expect(d.block).toBe(false);
  });
});

describe("detectPayload - catches encoded and decoded forms", () => {
  it("catches URL-encoded traversal", () => {
    expect(detectPayload("/x?p=%2e%2e%2f%2e%2e%2fetc/passwd")).toBe("path_traversal");
  });
  it("catches encoded XSS", () => {
    expect(detectPayload("/x?q=%3Cscript%3Ealert(1)%3C/script%3E")).toBe("xss");
  });
  it("catches encoded-whitespace SQLi even if decodeURIComponent under-applies (edge)", () => {
    // "UNION%20SELECT" with no other decoding must still be caught.
    expect(detectPayload("/p?q=1%20UNION%20SELECT%20pw%20FROM%20users")).toBe("sql_injection");
    expect(detectPayload("/p?q=1+OR+1=1")).toBe("sql_injection");
  });
  it("returns null for clean input", () => {
    expect(detectPayload("/products?category=shoes&sort=price")).toBeNull();
  });
  it("never throws on malformed percent-encoding", () => {
    expect(() => detectPayload("/x?p=%E0%A4%A")).not.toThrow();
    expect(detectPayload("/x?p=%zz")).toBeNull();
  });
});

import { detectHeaderAttack } from "@/lib/forcefield-web/enforce";
import { parseCidr } from "@/lib/forcefield-web/hosting";

describe("welcome-lane hole (regression): a UA claim never exempts a request from proof", () => {
  const googlebotUa = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";

  it("BLOCKS SQLi from a spoofed 'Googlebot' UA (used to ALLOW before the payload check)", () => {
    const d = decideEnforcement({ ...base, userAgent: googlebotUa, path: "/p", rawUrl: "/p?id=1%20UNION%20SELECT%20pw%20FROM%20users" }, R);
    expect(d.block).toBe(true);
    expect(d.reasonKind).toBe("payload");
    expect(d.attack).toBe("sql_injection");
  });

  it("BLOCKS a decoy trip and a middleware-bypass header from a 'GPTBot' UA", () => {
    expect(decideEnforcement({ ...base, userAgent: "GPTBot/1.2", path: "/_ff/records" }, R).reasonKind).toBe("decoy");
    const d = decideEnforcement({ ...base, userAgent: "GPTBot/1.2", path: "/admin", headerNames: [...base.headerNames, "x-middleware-subrequest"] }, R);
    expect(d.block).toBe(true);
    expect(d.attack).toBe("nextjs_middleware_bypass");
  });

  const compact = (c: string) => { const p = parseCidr(c)!; return `${p.base >>> 0}/${p.bits}`; };
  const withRanges = { ...R, verifiedAgentRanges: { Googlebot: [compact("66.249.64.0/19")] } };
  const fpOf = (h: string[]) => operatorFingerprint(h, undefined, "known_crawler");
  const H = ["host", "user-agent"];

  it("a VERIFIED Googlebot keeps the welcome lane even with a blocked fingerprint", () => {
    const d = decideEnforcement({ ...base, userAgent: googlebotUa, headerNames: H, path: "/", ip: "66.249.66.1" }, withRanges, { blockedFingerprints: [fpOf(H)] });
    expect(d.block).toBe(false);
  });

  it("a PROVEN impersonator (Googlebot UA, IP outside Google's ranges) loses the welcome lane", () => {
    const d = decideEnforcement({ ...base, userAgent: googlebotUa, headerNames: H, path: "/", ip: "203.0.113.9" }, withRanges, { blockedFingerprints: [fpOf(H)] });
    expect(d.block).toBe(true);
    expect(d.reasonKind).toBe("blocked_fingerprint");
  });

  it("an unverifiable claim (no ranges published) keeps the lane", () => {
    const d = decideEnforcement({ ...base, userAgent: googlebotUa, headerNames: H, path: "/", ip: "203.0.113.9" }, R, { blockedFingerprints: [fpOf(H)] });
    expect(d.block).toBe(false);
  });
});

describe("new payload rules", () => {
  it("CVE-2025-29927: x-middleware-subrequest from a client is a payload attack", () => {
    expect(detectHeaderAttack(["host", "X-Middleware-Subrequest"])).toBe("nextjs_middleware_bypass");
    expect(detectHeaderAttack(["host", "x-middleware-prefetch", "next-action"])).toBeNull();
    const d = decideEnforcement({ ...base, path: "/dashboard", headerNames: [...base.headerNames, "x-middleware-subrequest"] }, R);
    expect(d).toMatchObject({ block: true, reasonKind: "payload", attack: "nextjs_middleware_bypass" });
  });

  it("x-middleware-subrequest on the Forcefield control plane is our own edges, not an attack", () => {
    // Next sets the header on fetches made FROM middleware; every edge calls these
    // from its middleware. Seen ~6,700/day in production as false CVE-2025-29927 hits.
    const sub = [...base.headerNames, "x-middleware-subrequest"];
    for (const path of ["/api/site-analytics/ingest", "/api/forcefield/ruleset", "/api/forcefield/observe"]) {
      expect(detectHeaderAttack(sub, path)).toBeNull();
      expect(decideEnforcement({ ...base, path, headerNames: sub }, R).block).toBe(false);
    }
    // Everywhere else, and on lookalike paths, it is still the attack.
    for (const path of ["/admin", "/api/forcefield/ruleset/x", "/api/site-analytics/ingest2", "/API/forcefield/ruleset"]) {
      expect(detectHeaderAttack(sub, path)).toBe("nextjs_middleware_bypass");
    }
    expect(detectHeaderAttack(sub)).toBe("nextjs_middleware_bypass");
  });

  it("CVE-2024-4577 / CVE-2012-1823: PHP-CGI argument injection, soft-hyphen and plain forms", () => {
    // Verbatim watchTowr PoC query string.
    expect(detectPayload("/index.php?%ADd+allow_url_include%3d1+-d+auto_prepend_file%3dphp://input")).toBe("php_cgi_injection");
    expect(detectPayload("/cgi-bin/php-cgi.exe?%ADd+allow_url_include%3d1+%ADd+auto_prepend_file%3dphp://input")).toBe("php_cgi_injection");
    expect(detectPayload("/index.php?-d+allow_url_include%3don+-d+auto_prepend_file%3dphp%3a//input")).toBe("php_cgi_injection");
    expect(detectPayload("/x.php?-d allow_url_include=1")).toBe("php_cgi_injection");
  });

  it("_next/image SSRF to loopback / private / metadata / *.internal joins the ssrf family", () => {
    expect(detectPayload("/_next/image?url=http://127.0.0.1:3000/admin&w=64&q=75")).toBe("ssrf");
    expect(detectPayload("/_next/image?url=http%3A%2F%2F169.254.169.254%2Flatest%2Fmeta-data&w=64&q=75")).toBe("ssrf");
    expect(detectPayload("/_next/image?w=64&url=http://10.0.0.5/x.png")).toBe("ssrf");
    expect(detectPayload("/_next/image?url=http://redis.internal:6379/&w=64")).toBe("ssrf");
    expect(detectPayload("/_next/image?url=http://localhost/x&w=64")).toBe("ssrf");
  });

  it("OAST callback hosts in a parameter are blind-SSRF tooling", () => {
    expect(detectPayload("/fetch?u=http://abc123.oast.fun/x")).toBe("ssrf");
  });

  it("NO false positives on real-browser URLs that look superficially similar", () => {
    const benign = [
      "/_next/image?url=%2Fimages%2Fhero.png&w=1920&q=75",
      "/_next/image?url=https%3A%2F%2Fcdn.example.com%2Fa.png&w=640&q=75",
      "/_next/image?url=/logo.svg&w=128&q=75",
      "/search?q=how+to+set+allow_url_include+safely",
      "/docs/php-cgi?section=-d-flags",
      "/blog/the-internal-memo?ref=10.5",
      "/products?id=10&sort=-date",
      "/search?q=co%C2%ADdirect",
      "/login?next=/dashboard",
    ];
    for (const u of benign) expect([u, detectPayload(u)]).toEqual([u, null]);
    for (const u of benign) expect(decideEnforcement({ ...base, path: u.split("?")[0], rawUrl: u }, R).block).toBe(false);
  });
});

describe("authenticated requests (site-attested)", () => {
  const PW = ["host", "connection", "sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform", "upgrade-insecure-requests", "user-agent", "accept", "sec-fetch-site", "sec-fetch-mode", "sec-fetch-user", "sec-fetch-dest", "accept-encoding", "accept-language"];
  const pwUa = "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/131.0.0.0 Safari/537.36";
  const pwFp = operatorFingerprint(PW, "HeadlessChrome", "headless");

  it("Playwright default headers + an admin-blocked headless fp -> BLOCKED when anonymous", () => {
    const d = decideEnforcement({ ...base, path: "/login", userAgent: pwUa, headerNames: PW }, R, { blockedFingerprints: [pwFp] });
    expect(d.reasonKind).toBe("blocked_fingerprint");
  });

  it("same request, authenticated (e.g. a valid synthetic-monitor token) -> ALLOWED", () => {
    const d = decideEnforcement({ ...base, path: "/login", userAgent: pwUa, headerNames: PW, authenticated: true }, R, { blockedFingerprints: [pwFp] });
    expect(d.block).toBe(false);
  });

  it("authenticated + SQLi / decoy / bypass header -> STILL blocked", () => {
    expect(decideEnforcement({ ...base, authenticated: true, path: "/p", rawUrl: "/p?id=1 UNION SELECT 1" }, R).attack).toBe("sql_injection");
    expect(decideEnforcement({ ...base, authenticated: true, path: "/_ff/records" }, R).reasonKind).toBe("decoy");
    expect(decideEnforcement({ ...base, authenticated: true, path: "/", headerNames: [...base.headerNames, "x-middleware-subrequest"] }, R).attack).toBe("nextjs_middleware_bypass");
  });

  it("authenticated named tool (our own DAST with credentials) is not blocked by the attack-tool rule", () => {
    expect(decideEnforcement({ ...base, authenticated: true, path: "/", userAgent: "Nuclei - Open-source project" }, R).block).toBe(false);
    expect(decideEnforcement({ ...base, path: "/", userAgent: "Nuclei - Open-source project" }, R).reasonKind).toBe("attack_tool");
  });
});

describe("bodyAttack - a body-proven attack an adapter supplies", () => {
  it("blocks on a bodyAttack label, recorded as a payload", () => {
    const d = decideEnforcement({ ...base, method: "POST", path: "/upload.php", bodyAttack: "php2shell" }, R);
    expect(d).toMatchObject({ block: true, reasonKind: "payload", attack: "php2shell" });
  });

  it("a signed-in request is still blocked for a body attack (auth never exempts proof)", () => {
    const d = decideEnforcement({ ...base, method: "POST", path: "/action", authenticated: true, bodyAttack: "react2shell" }, R);
    expect(d).toMatchObject({ block: true, attack: "react2shell" });
  });

  it("no bodyAttack -> no block (the field is additive, never a new false positive)", () => {
    expect(decideEnforcement({ ...base, method: "POST", path: "/upload.php" }, R).block).toBe(false);
  });
});

describe("decideEnforcement - the site's own AI training crawler policy", () => {
  const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
  it("turns away an agent the site blocked, with reason agent_policy", () => {
    const d = decideEnforcement({ ...base, path: "/", userAgent: GPTBOT }, R, { blockedAgents: ["GPTBot"] });
    expect(d).toMatchObject({ block: true, reasonKind: "agent_policy" });
    expect(d.reason).toContain("GPTBot");
  });
  it("leaves other agents and real browsers alone, and blocks nothing with an empty policy", () => {
    expect(decideEnforcement({ ...base, path: "/", userAgent: "Mozilla/5.0 (compatible; OAI-SearchBot/1.0)" }, R, { blockedAgents: ["GPTBot"] }).block).toBe(false);
    expect(decideEnforcement({ ...base, path: "/" }, R, { blockedAgents: ["GPTBot"] }).block).toBe(false);
    expect(decideEnforcement({ ...base, path: "/", userAgent: GPTBOT }, R, { blockedAgents: [] }).block).toBe(false);
    expect(decideEnforcement({ ...base, path: "/", userAgent: GPTBOT }, R).block).toBe(false);
  });
  it("an attack payload from the same agent is still reported as a payload, not as policy", () => {
    expect(decideEnforcement({ ...base, path: "/x", rawUrl: "/x?q=<script>alert(1)</script>", userAgent: GPTBOT }, R, { blockedAgents: ["GPTBot"] }).reasonKind).toBe("payload");
  });
});

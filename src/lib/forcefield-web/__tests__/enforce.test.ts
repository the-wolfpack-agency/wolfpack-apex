import { decideEnforcement, detectPayload } from "@/lib/forcefield-web/enforce";
import { DEFAULT_RULESET } from "@/lib/forcefield-web/ruleset";

const R = DEFAULT_RULESET;
const base = {
  method: "GET",
  headerNames: ["host", "user-agent", "accept", "accept-language", "accept-encoding"],
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

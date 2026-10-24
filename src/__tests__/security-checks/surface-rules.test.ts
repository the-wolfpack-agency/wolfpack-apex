import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MIDDLEWARE_SUBREQUEST_VALUES,
  headerFindings,
  imageProxyFinding,
  isRefused,
  middlewareBypassFinding,
  secretPathFinding,
  toHeaderMap,
  type SiteConfig,
} from "../../../scripts/security/lib/surface";

const GOOD = {
  "content-security-policy": "default-src 'self'; frame-ancestors 'none'",
  "strict-transport-security": "max-age=63072000",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
  server: "Vercel",
};

describe("headerFindings", () => {
  it("is clean for a hardened response (frame-ancestors counts as frame protection)", () => {
    expect(headerFindings("site", GOOD)).toEqual([]);
  });

  it("reports each missing header (the ogiam.com shape on 2026-10-24: HSTS only)", () => {
    const rules = headerFindings("ogiam", { "strict-transport-security": "max-age=63072000", server: "Vercel" }).map((f) => f.rule);
    expect(rules).toEqual([
      "headers.csp-missing",
      "headers.nosniff-missing",
      "headers.frame-protection-missing",
      "headers.referrer-policy-missing",
    ]);
  });

  it("treats report-only CSP as weaker than enforced, short HSTS as low", () => {
    const h = {
      "content-security-policy-report-only": "default-src 'self'",
      "x-frame-options": "DENY",
      "strict-transport-security": "max-age=300",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    };
    expect(headerFindings("s", h).map((f) => [f.rule, f.severity])).toEqual([
      ["headers.csp-report-only", "low"],
      ["headers.hsts-short", "low"],
    ]);
  });

  it("flags version-leaking X-Powered-By and Server banners", () => {
    const f = headerFindings("s", { ...GOOD, "x-powered-by": "PHP/7.4.3", server: "nginx/1.18.0" });
    expect(f.map((x) => [x.rule, x.severity])).toEqual([
      ["headers.x-powered-by", "medium"],
      ["headers.server-version", "medium"],
    ]);
    expect(headerFindings("s", { ...GOOD, "x-powered-by": "Next.js" }).map((x) => x.severity)).toEqual(["low"]);
  });

  it("lower-cases a fetch Headers object", () => {
    expect(toHeaderMap(new Headers({ "X-Frame-Options": "DENY" }))).toEqual({ "x-frame-options": "DENY" });
  });
});

describe("secretPathFinding", () => {
  it("passes 404, 403 and redirects", () => {
    expect(secretPathFinding("s", "/.env", 404, "text/html", "")).toBeNull();
    expect(secretPathFinding("s", "/.env", 403, "", "")).toBeNull();
    expect(secretPathFinding("s", "/.git/config", 307, "", "")).toBeNull();
  });

  it("is critical when the real file is served", () => {
    expect(secretPathFinding("s", "/.env", 200, "text/plain", "DATABASE_URL=postgres://x\nAPI_KEY=abc")?.severity).toBe("critical");
    expect(secretPathFinding("s", "/.git/config", 200, "text/plain", "[core]\n\trepositoryformatversion = 0")?.severity).toBe("critical");
  });

  it("is only low when a 200 is an app fallback page", () => {
    const f = secretPathFinding("s", "/.env", 200, "text/html", "<html><body>Not here</body></html>");
    expect(f?.rule).toBe("exposure.secret-path-2xx");
    expect(f?.severity).toBe("low");
  });
});

describe("imageProxyFinding", () => {
  it("flags only a 200 image response", () => {
    expect(imageProxyFinding("s", 200, "image/png", "https://x/y.png")?.severity).toBe("high");
    expect(imageProxyFinding("s", 400, "text/plain", "https://x/y.png")).toBeNull();
    expect(imageProxyFinding("s", 404, "text/html", "https://x/y.png")).toBeNull();
    expect(imageProxyFinding("s", 200, "text/html", "https://x/y.png")).toBeNull();
  });
});

describe("middlewareBypassFinding (CVE-2025-29927)", () => {
  it("is critical when a refused request is served once the header is added", () => {
    expect(middlewareBypassFinding("s", "/admin", { status: 307, location: "/login" }, { status: 200, location: null }, "middleware")?.severity).toBe("critical");
    expect(middlewareBypassFinding("s", "/api/x", { status: 401, location: null }, { status: 200, location: null }, "middleware")?.rule).toBe(
      "auth.middleware-subrequest-bypass",
    );
  });

  it("passes when the header changes nothing, and has nothing to test on a public path", () => {
    expect(middlewareBypassFinding("s", "/admin", { status: 307, location: "/login" }, { status: 307, location: "/login" }, "m")).toBeNull();
    expect(middlewareBypassFinding("s", "/", { status: 200, location: null }, { status: 200, location: null }, "m")).toBeNull();
    expect(isRefused({ status: 403, location: null })).toBe(true);
    expect(isRefused({ status: 200, location: null })).toBe(false);
  });

  it("probes both the recursion-depth and path header forms", () => {
    expect(MIDDLEWARE_SUBREQUEST_VALUES).toEqual(expect.arrayContaining(["middleware:middleware:middleware:middleware:middleware", "pages/_middleware"]));
  });
});

describe("scripts/security/surface-sites.json", () => {
  it("lists every production site over https with a valid protectedPath", () => {
    const cfg = JSON.parse(readFileSync(join(__dirname, "..", "..", "..", "scripts", "security", "surface-sites.json"), "utf8")) as { sites: SiteConfig[] };
    const names = cfg.sites.map((s) => s.name);
    expect(names).toEqual(expect.arrayContaining(["instinct", "weekend-with-porsche", "ogiam", "aidan-mulready", "fdos"]));
    expect(new Set(names).size).toBe(names.length);
    for (const s of cfg.sites) {
      expect(s.url).toMatch(/^https:\/\/[^/]+$/);
      if (s.protectedPath !== null) expect(s.protectedPath).toMatch(/^\//);
    }
  });
});

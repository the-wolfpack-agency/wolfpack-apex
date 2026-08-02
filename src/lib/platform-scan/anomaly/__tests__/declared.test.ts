/**
 * Deriving what a site can explain about its own traffic.
 *
 * The tests that matter here are the ones about a CSP that permits everything.
 * If `connect-src *` counted as an explanation, the sites with the weakest
 * security posture would produce the cleanest anomaly reports, and we would be
 * telling exactly the wrong clients that they are fine.
 */
import {
  buildDeclarations,
  declaredHostList,
  explains,
  explanationFor,
  hostFromCspSource,
  parseCsp,
} from "../declared";

describe("parseCsp", () => {
  it("splits directives and their sources", () => {
    const p = parseCsp("default-src 'self'; connect-src https://api.example.com https://cdn.example.net");
    expect(p.get("default-src")).toEqual(["'self'"]);
    expect(p.get("connect-src")).toEqual(["https://api.example.com", "https://cdn.example.net"]);
  });

  it("honours the FIRST of a duplicated directive, as browsers do", () => {
    // Invalid CSP, but it happens. If an appended duplicate widened what we
    // consider declared, appending one would be a way to hide traffic from
    // this scan.
    const p = parseCsp("connect-src https://a.example.com; connect-src *");
    expect(p.get("connect-src")).toEqual(["https://a.example.com"]);
  });

  it("tolerates junk without throwing", () => {
    expect(() => parseCsp(";;  ; connect-src ;")).not.toThrow();
    expect(parseCsp("connect-src").get("connect-src")).toEqual([]);
  });
});

describe("hostFromCspSource", () => {
  it("extracts a host from a scheme-qualified source", () => {
    expect(hostFromCspSource("https://api.example.com")).toEqual({ host: "api.example.com" });
  });

  it("strips port and path", () => {
    expect(hostFromCspSource("https://api.example.com:8443/collect")).toEqual({ host: "api.example.com" });
  });

  it("turns a subdomain wildcard into a dot-prefixed host", () => {
    expect(hostFromCspSource("*.example.com")).toEqual({ host: ".example.com" });
  });

  it.each(["*", "https:", "http:", "data:", "blob:", "https://*"])("treats %s as permissive, not as a host", (src) => {
    expect(hostFromCspSource(src)).toEqual({ permissive: true });
  });

  it("treats a whole-TLD wildcard as permissive", () => {
    // "*.com" is not a declaration of intent by any reading.
    expect(hostFromCspSource("*.com")).toEqual({ permissive: true });
    expect(hostFromCspSource("*.")).toEqual({ permissive: true });
  });

  it("ignores CSP keywords", () => {
    for (const k of ["'self'", "'none'", "'unsafe-inline'", "'strict-dynamic'", "'sha256-abc123'"]) {
      expect(hostFromCspSource(k)).toBeNull();
    }
  });

  it("ignores bare tokens that are not hosts", () => {
    expect(hostFromCspSource("localhost")).toBeNull();
  });
});

describe("buildDeclarations", () => {
  const page = "https://client.example.com/pricing";

  it("explains the site's own origin and its subdomains", () => {
    const set = buildDeclarations({ pageUrl: page });
    expect(explanationFor(set, "client.example.com")?.source).toBe("self");
    expect(explanationFor(set, "cdn.client.example.com")?.source).toBe("self");
  });

  it("reads the site's CSP as a declaration of intent", () => {
    const set = buildDeclarations({
      pageUrl: page,
      headers: { "content-security-policy": "connect-src https://api.vendor.io; script-src https://js.vendor.io" },
    });
    expect(explanationFor(set, "api.vendor.io")?.detail).toBe("csp: connect-src");
    expect(explanationFor(set, "js.vendor.io")?.detail).toBe("csp: script-src");
  });

  it("matches the CSP header case-insensitively, as HTTP requires", () => {
    const set = buildDeclarations({
      pageUrl: page,
      headers: { "Content-Security-Policy": "connect-src https://api.vendor.io" },
    });
    expect(explanationFor(set, "api.vendor.io")).not.toBeNull();
  });

  it("counts a report-only CSP", () => {
    // Report-only still states what the site believes it contacts. The
    // difference is whether the browser blocks, not whether intent was declared.
    const set = buildDeclarations({
      pageUrl: page,
      headers: { "content-security-policy-report-only": "connect-src https://api.vendor.io" },
    });
    expect(explanationFor(set, "api.vendor.io")?.source).toBe("csp");
  });

  it("covers img-src, because a tracking pixel is an image", () => {
    const set = buildDeclarations({
      pageUrl: page,
      headers: { "content-security-policy": "img-src https://pixel.adnetwork.com" },
    });
    expect(explanationFor(set, "pixel.adnetwork.com")).not.toBeNull();
  });

  it("records a permissive directive instead of letting it explain everything", () => {
    const set = buildDeclarations({ pageUrl: page, headers: { "content-security-policy": "connect-src *" } });
    expect(set.permissive).toContain("connect-src *");
    expect(explanationFor(set, "tracker.example.net")).toBeNull();
  });

  it("does not let a permissive directive silence a specific one alongside it", () => {
    const set = buildDeclarations({
      pageUrl: page,
      headers: { "content-security-policy": "connect-src https://api.vendor.io *" },
    });
    expect(explanationFor(set, "api.vendor.io")).not.toBeNull();
    expect(explanationFor(set, "other.example.net")).toBeNull();
    expect(set.permissive).toHaveLength(1);
  });

  it("flags noEvidence when only the site's own origin is known", () => {
    // Every site explains itself. If that counted as evidence, every third
    // party on every unconfigured site would read as anomalous.
    expect(buildDeclarations({ pageUrl: page }).noEvidence).toBe(true);
  });

  it("does not flag noEvidence once a CSP or an operator entry exists", () => {
    expect(buildDeclarations({ pageUrl: page, headers: { "content-security-policy": "connect-src 'self'" } }).noEvidence).toBe(false);
    expect(buildDeclarations({ pageUrl: page, operatorAllowed: ["vendor.io"] }).noEvidence).toBe(false);
  });

  it("keeps provenance so a reviewer can weigh the explanation", () => {
    const set = buildDeclarations({
      pageUrl: page,
      headers: { "content-security-policy": "connect-src https://shared.example.net" },
      operatorAllowed: ["shared.example.net"],
      integrationHosts: [{ host: "shared.example.net", name: "Segment" }],
    });
    // The strongest wins: a known integration beats "someone typed it in once".
    expect(explanationFor(set, "shared.example.net")?.source).toBe("integration");
  });

  it("normalises www and case in operator entries", () => {
    const set = buildDeclarations({ pageUrl: page, operatorAllowed: ["  WWW.Vendor.IO  "] });
    expect(explanationFor(set, "vendor.io")?.source).toBe("operator");
  });
});

describe("explains", () => {
  it("matches on a dot boundary, so a lookalike domain is not covered", () => {
    // The same rule identify() uses. "evil-vendor.io" must not pass as
    // a subdomain of vendor.io.
    const d = { host: ".vendor.io", source: "csp" as const, detail: "" };
    expect(explains(d, "api.vendor.io")).toBe(true);
    expect(explains(d, "vendor.io")).toBe(true);
    expect(explains(d, "evil-vendor.io")).toBe(false);
    expect(explains(d, "vendor.io.attacker.com")).toBe(false);
  });

  it("requires an exact match without a leading dot", () => {
    const d = { host: "vendor.io", source: "csp" as const, detail: "" };
    expect(explains(d, "vendor.io")).toBe(true);
    expect(explains(d, "api.vendor.io")).toBe(false);
  });
});

describe("declaredHostList", () => {
  it("flattens to the plain strings unexplained() takes, dots stripped", () => {
    const set = buildDeclarations({
      pageUrl: "https://client.example.com/",
      headers: { "content-security-policy": "connect-src *.vendor.io" },
    });
    const list = declaredHostList(set);
    expect(list).toContain("vendor.io");
    expect(list.every((h) => !h.startsWith("."))).toBe(true);
  });
});

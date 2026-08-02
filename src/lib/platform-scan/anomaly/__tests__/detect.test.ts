/**
 * Anomaly detection: what the system cannot account for.
 *
 * Most of these tests are about the detector REFUSING to make a claim. That is
 * the hard part of an anomaly feature — an over-eager one gets muted after the
 * first report, and a muted detector is worth less than none, because everyone
 * believes it is watching.
 */
import { buildDeclarations } from "../declared";
import { detectAnomalies, foldBaseline, shouldPersistBaseline, type HostBaseline } from "../detect";
import type { NetworkObservation } from "../../network/observations";

const PAGE = "https://client.example.com/";

function obs(url: string, over: Partial<NetworkObservation> = {}): NetworkObservation {
  return { url, pageUrl: PAGE, resourceType: "script", atMs: 100, status: 200, ...over };
}

const NO_DECLS = buildDeclarations({ pageUrl: PAGE, operatorAllowed: [] });
/** A site with a real CSP, so declarations mean something. */
function withCsp(csp: string) {
  return buildDeclarations({ pageUrl: PAGE, headers: { "content-security-policy": csp } });
}

function base(...hosts: string[]): HostBaseline[] {
  return hosts.map((host) => ({
    host,
    firstSeenAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-07-01T00:00:00.000Z",
    scanCount: 4,
  }));
}

describe("the refusals", () => {
  it("does not call anything NEW when there is no baseline", () => {
    // A first scan where every host is "new" buries the real signal under the
    // client's entire normal stack, at the exact moment they are deciding
    // whether to trust the tool.
    const r = detectAnomalies({
      observations: [obs("https://hotjar.com/a.js"), obs("https://mixpanel.com/b.js")],
      declarations: withCsp("connect-src 'self'"),
    });
    expect(r.findings.map((f) => f.novelty)).toEqual(["no-baseline", "no-baseline"]);
    expect(r.totals.novel).toBe(0);
    expect(r.caveats.join(" ")).toMatch(/No previous scan/i);
  });

  it("distinguishes 'never scanned' from 'scanned and saw nothing'", () => {
    const neverScanned = detectAnomalies({ observations: [obs("https://hotjar.com/a.js")], declarations: NO_DECLS });
    const scannedEmpty = detectAnomalies({
      observations: [obs("https://hotjar.com/a.js")],
      declarations: NO_DECLS,
      baseline: [],
    });
    expect(neverScanned.findings[0].novelty).toBe("no-baseline");
    expect(scannedEmpty.findings[0].novelty).toBe("new");
  });

  it("reports no disappearances when the scan observed nothing", () => {
    // Every known host would look removed. That is a failed scan wearing the
    // costume of a big change.
    const r = detectAnomalies({ observations: [], declarations: NO_DECLS, baseline: base("hotjar.com", "mixpanel.com") });
    expect(r.disappeared).toEqual([]);
    expect(r.caveats.join(" ")).toMatch(/usually means the scan failed/i);
  });

  it("says so when the site publishes nothing to check against", () => {
    const r = detectAnomalies({ observations: [obs("https://hotjar.com/a.js")], declarations: NO_DECLS, baseline: [] });
    expect(r.caveats.join(" ")).toMatch(/no Content-Security-Policy/i);
  });

  it("says so when the CSP permits any host", () => {
    const r = detectAnomalies({
      observations: [obs("https://hotjar.com/a.js")],
      declarations: withCsp("connect-src *"),
      baseline: [],
    });
    expect(r.caveats.join(" ")).toMatch(/permits any host/i);
  });

  it("says so when the page did not load", () => {
    const r = detectAnomalies({ observations: [], declarations: NO_DECLS, pageLoaded: false });
    expect(r.caveats.join(" ")).toMatch(/did not load/i);
  });
});

describe("what counts as explained", () => {
  it("drops a declared host that has been seen before", () => {
    // Reporting every legitimate request is how a report stops being read.
    const r = detectAnomalies({
      observations: [obs("https://api.vendor.io/x")],
      declarations: withCsp("connect-src https://api.vendor.io"),
      baseline: base("api.vendor.io"),
    });
    expect(r.findings).toHaveLength(0);
    expect(r.totals.thirdParties).toBe(1);
  });

  it("still surfaces a declared host the first time it appears, at low severity", () => {
    // The site permitted it, so this is not an incident. It is still a change
    // worth showing on a diff of "what does this site talk to".
    const r = detectAnomalies({
      observations: [obs("https://api.vendor.io/x")],
      declarations: withCsp("connect-src https://api.vendor.io"),
      baseline: [],
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].severity).toBe("low");
    expect(r.findings[0].explainedBy?.source).toBe("csp");
    expect(r.totals.unexplained).toBe(0);
  });

  it("does not treat the site's own subdomain as a third party at all", () => {
    const r = detectAnomalies({
      observations: [obs("https://cdn.client.example.com/x.js")],
      declarations: NO_DECLS,
      baseline: [],
    });
    expect(r.totals.thirdParties).toBe(0);
    expect(r.findings).toHaveLength(0);
  });
});

describe("severity", () => {
  it("calls an unexplained NEW session-replay vendor critical", () => {
    // It is recording the client's visitors, and nothing accounts for it.
    const r = detectAnomalies({
      observations: [obs("https://hotjar.com/hj.js")],
      declarations: withCsp("connect-src 'self'"),
      baseline: base("mixpanel.com"),
    });
    expect(r.findings[0]).toMatchObject({ host: "hotjar.com", severity: "critical", novelty: "new" });
  });

  it("calls an unexplained NEW credentialed request critical whatever its kind", () => {
    const r = detectAnomalies({
      observations: [obs("https://unknown-thing.example.net/collect", { withCredentials: true })],
      declarations: withCsp("connect-src 'self'"),
      baseline: [],
    });
    expect(r.findings[0].severity).toBe("critical");
  });

  it("downgrades an unexplained host that every previous scan also saw", () => {
    // Long-standing and undeclared is untidy. Newly arrived is an incident.
    // Collapsing the two would make every report look like an emergency.
    const r = detectAnomalies({
      observations: [obs("https://mixpanel.com/x.js")],
      declarations: withCsp("connect-src 'self'"),
      baseline: base("mixpanel.com"),
    });
    expect(r.findings[0]).toMatchObject({ novelty: "known", severity: "medium" });
  });

  it("does not let the baseline launder a finding", () => {
    // Scanning an already-compromised site must not bless the compromise on
    // the second run. It loses its novelty, never its finding.
    const r = detectAnomalies({
      observations: [obs("https://hotjar.com/hj.js")],
      declarations: withCsp("connect-src 'self'"),
      baseline: base("hotjar.com"),
    });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].explainedBy).toBeNull();
    expect(r.totals.unexplained).toBe(1);
  });

  it("ranks a new unexplained CDN below a new unexplained tracker, but still reports it", () => {
    const r = detectAnomalies({
      observations: [obs("https://jsdelivr.net/x.js"), obs("https://hotjar.com/hj.js", { atMs: 200 })],
      declarations: withCsp("connect-src 'self'"),
      baseline: [],
    });
    expect(r.findings.map((f) => f.host)).toEqual(["hotjar.com", "jsdelivr.net"]);
    expect(r.findings[1].severity).toBe("medium");
  });

  it("sorts most serious first", () => {
    const r = detectAnomalies({
      observations: [
        obs("https://jsdelivr.net/a.js"),
        obs("https://hotjar.com/hj.js", { atMs: 50 }),
        obs("https://plausible.io/p.js", { atMs: 60 }),
      ],
      declarations: withCsp("connect-src 'self'"),
      baseline: [],
    });
    const sev = r.findings.map((f) => f.severity);
    expect(sev).toEqual([...sev].sort((a, b) => ["critical", "high", "medium", "low"].indexOf(a) - ["critical", "high", "medium", "low"].indexOf(b)));
  });
});

describe("consent evidence", () => {
  it("records that a tracker fired before any consent could be given", () => {
    const r = detectAnomalies({
      observations: [obs("https://hotjar.com/hj.js", { atMs: 40 })],
      declarations: withCsp("connect-src 'self'"),
      baseline: [],
      consentAtMs: null,
    });
    expect(r.findings[0].evidence.beforeConsent).toBe(true);
  });

  it("does not count a CDN request as a consent problem", () => {
    // A report that flags every font file trains people to skim past it.
    const r = detectAnomalies({
      observations: [obs("https://jsdelivr.net/f.woff", { resourceType: "font", atMs: 10 })],
      declarations: withCsp("connect-src 'self'"),
      baseline: [],
      consentAtMs: null,
    });
    expect(r.findings[0].evidence.beforeConsent).toBe(false);
  });

  it("respects a real consent time", () => {
    const r = detectAnomalies({
      observations: [obs("https://hotjar.com/hj.js", { atMs: 900 })],
      declarations: withCsp("connect-src 'self'"),
      baseline: [],
      consentAtMs: 500,
    });
    expect(r.findings[0].evidence.beforeConsent).toBe(false);
  });
});

describe("summaries", () => {
  it("reads as plain English, with the vendor named when we know it", () => {
    const r = detectAnomalies({
      observations: [obs("https://hotjar.com/hj.js")],
      declarations: withCsp("connect-src 'self'"),
      baseline: base("other.example.net"),
    });
    expect(r.findings[0].summary).toBe(
      "Hotjar (hotjar.com) was contacted for the first time, and nothing in the site's own declarations accounts for it.",
    );
  });

  it("does not claim novelty in the summary when there is no baseline", () => {
    const r = detectAnomalies({ observations: [obs("https://hotjar.com/hj.js")], declarations: NO_DECLS });
    expect(r.findings[0].summary).toMatch(/first scan of this site, so we cannot yet say whether it is new/);
  });

  it("carries evidence a reviewer can check without re-running", () => {
    const r = detectAnomalies({
      observations: [obs("https://hotjar.com/hj.js", { atMs: 42, resourceType: "xhr", status: 204 })],
      declarations: NO_DECLS,
      baseline: [],
    });
    expect(r.findings[0].evidence).toMatchObject({ firstContactMs: 42, resourceType: "xhr", status: 204 });
  });
});

describe("disappearances", () => {
  it("lists a baseline host this scan did not see", () => {
    const r = detectAnomalies({
      observations: [obs("https://mixpanel.com/x.js")],
      declarations: NO_DECLS,
      baseline: base("mixpanel.com", "hotjar.com"),
    });
    expect(r.disappeared).toEqual(["hotjar.com"]);
  });
});

describe("foldBaseline", () => {
  const NOW = "2026-08-02T00:00:00.000Z";

  it("adds a host it has not seen, with a count of one", () => {
    const next = foldBaseline([], [obs("https://hotjar.com/hj.js")], NOW);
    expect(next).toEqual([{ host: "hotjar.com", firstSeenAt: NOW, lastSeenAt: NOW, scanCount: 1 }]);
  });

  it("keeps firstSeenAt and advances the count", () => {
    // firstSeenAt is the answer to "when did this appear", which is the whole
    // point of keeping a baseline. Overwriting it would erase the incident.
    const next = foldBaseline(base("hotjar.com"), [obs("https://hotjar.com/hj.js")], NOW);
    expect(next[0]).toEqual({ host: "hotjar.com", firstSeenAt: "2026-01-01T00:00:00.000Z", lastSeenAt: NOW, scanCount: 5 });
  });

  it("keeps a host that was not seen this time", () => {
    // Forgetting it would make it "new" again the next time it appears, which
    // is a false alarm on a host we already know about.
    const next = foldBaseline(base("hotjar.com"), [], NOW);
    expect(next.map((b) => b.host)).toEqual(["hotjar.com"]);
    expect(next[0].scanCount).toBe(4);
  });

  it("does not mutate the baseline it was given", () => {
    const prev = base("hotjar.com");
    foldBaseline(prev, [obs("https://hotjar.com/hj.js")], NOW);
    expect(prev[0].scanCount).toBe(4);
  });
});

describe("shouldPersistBaseline", () => {
  it("refuses a scan whose page did not load", () => {
    // One bad run must not erase the history that makes novelty detectable.
    expect(shouldPersistBaseline({ pageLoaded: false, observations: [obs("https://hotjar.com/x")] })).toBe(false);
  });

  it("refuses a scan that observed nothing at all", () => {
    expect(shouldPersistBaseline({ pageLoaded: true, observations: [] })).toBe(false);
  });

  it("accepts a loaded scan that saw only first-party traffic", () => {
    // A site with no third parties is a real, and good, result.
    expect(shouldPersistBaseline({ pageLoaded: true, observations: [obs("https://client.example.com/app.js")] })).toBe(true);
  });
});

describe("end to end", () => {
  it("turns a real-looking injection into one critical finding", () => {
    const declarations = buildDeclarations({
      pageUrl: PAGE,
      headers: { "content-security-policy": "default-src 'self'; script-src 'self' https://cdn.client.example.com; connect-src 'self' https://plausible.io" },
    });
    const r = detectAnomalies({
      observations: [
        obs("https://cdn.client.example.com/app.js", { atMs: 10 }),
        obs("https://plausible.io/script.js", { atMs: 20 }),
        // The one nothing accounts for.
        obs("https://analytics.evil-cdn.net/collect", { atMs: 30, withCredentials: true, resourceType: "xhr" }),
      ],
      declarations,
      baseline: base("plausible.io"),
      consentAtMs: null,
      pageLoaded: true,
    });

    expect(r.totals).toEqual({ thirdParties: 2, unexplained: 1, novel: 1 });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]).toMatchObject({
      host: "analytics.evil-cdn.net",
      severity: "critical",
      novelty: "new",
      explainedBy: null,
    });
    expect(r.findings[0].evidence.withCredentials).toBe(true);
    expect(r.caveats).toEqual([]);
  });
});

/** @jest-environment node */
import { stateChangeOf } from "@/lib/forcefield-web/accountability";
import { _resetIntegrityDedupe, handleIntegrityReport, integrityEndpoint, integrityPolicy, INTEGRITY_REPORT_PATH, normalizeIntegrityReports } from "@/lib/forcefield-web/integrity";

const env = { FORCEFIELD_INGEST_URL: "https://hub.example/api/site-analytics/ingest", SITE_ANALYTICS_INGEST_TOKEN: "site-token" } as unknown as NodeJS.ProcessEnv;
const classic = (blocked: string, directive = "script-src-elem", page = "https://site.example/checkout?x=1") =>
  ({ "csp-report": { "document-uri": page, "blocked-uri": blocked, "effective-directive": directive, "violated-directive": directive, disposition: "report" } });

describe("integrityPolicy", () => {
  it("is report-only material: watches script, frame, connect and form targets, and reports to the site's own route", () => {
    const p = integrityPolicy();
    expect(p).toBe(`script-src 'self' 'unsafe-inline' 'unsafe-eval'; frame-src 'self'; connect-src 'self'; form-action 'self'; report-uri ${INTEGRITY_REPORT_PATH}`);
    expect(p).not.toMatch(/default-src|img-src|style-src/);
  });
  it("names the site's known origins and ignores anything that is not an origin", () => {
    const p = integrityPolicy({ allow: { "frame-src": ["https://www.youtube.com", "https://evil.example; script-src *"], "connect-src": ["https://api.example:8443"] } });
    expect(p).toContain("frame-src 'self' https://www.youtube.com;");
    expect(p).toContain("connect-src 'self' https://api.example:8443;");
    expect(p).not.toContain("evil.example");
  });
});

describe("normalizeIntegrityReports", () => {
  it("keeps only the directive family, the blocked ORIGIN and the page path (never a full URL or query)", () => {
    expect(normalizeIntegrityReports(classic("https://cdn.skim.example/a/b.js?card=1"))).toEqual([
      { directive: "script-src", blockedOrigin: "https://cdn.skim.example", page: "/checkout" },
    ]);
  });
  it("reads the Reporting API batch format too", () => {
    const batch = [
      { type: "csp-violation", body: { documentURL: "https://s.example/", blockedURL: "https://pay.stranger.example/collect", effectiveDirective: "connect-src" } },
      { type: "deprecation", body: {} },
      { type: "csp-violation", body: { documentURL: "https://s.example/cart", blockedURL: "https://forms.stranger.example/x", effectiveDirective: "form-action" } },
    ];
    expect(normalizeIntegrityReports(batch)).toEqual([
      { directive: "connect-src", blockedOrigin: "https://pay.stranger.example", page: "/" },
      { directive: "form-action", blockedOrigin: "https://forms.stranger.example", page: "/cart" },
    ]);
  });
  it("drops browser-extension, inline, eval and unknown-directive noise", () => {
    for (const b of ["chrome-extension://abc/x.js", "moz-extension://x/y", "safari-web-extension://z", "inline", "eval", "about", ""]) {
      expect(normalizeIntegrityReports(classic(b))).toEqual([]);
    }
    expect(normalizeIntegrityReports(classic("https://x.example/a", "img-src"))).toEqual([]);
    expect(normalizeIntegrityReports(classic("data:text/javascript,alert(1)"))).toEqual([{ directive: "script-src", blockedOrigin: "data", page: "/checkout" }]);
  });
  it("anything that is not a report reads as none", () => {
    for (const b of [null, 42, "x", {}, { "csp-report": null }, [{ type: "csp-violation" }]]) expect(normalizeIntegrityReports(b)).toEqual([]);
  });
});

describe("handleIntegrityReport (the site's report route)", () => {
  const req = (body: string, h: Record<string, string> = {}) => ({ headers: new Headers({ "user-agent": "Mozilla/5.0 Chrome/130", "content-type": "application/csp-report", ...h }), text: async () => body });
  beforeEach(() => { _resetIntegrityDedupe(); jest.restoreAllMocks(); });

  it("forwards the normalized reports with the site token and always answers 204", async () => {
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}"));
    const res = await handleIntegrityReport("aidanmulready", req(JSON.stringify(classic("https://cdn.skim.example/a.js"))), env, 1_000);
    expect(res.status).toBe(204);
    const [url, init] = f.mock.calls[0];
    expect(url).toBe("https://hub.example/api/forcefield/integrity");
    expect((init as RequestInit).headers).toMatchObject({ "x-ingest-token": "site-token" });
    const sent = JSON.parse(String((init as RequestInit).body));
    expect(sent).toMatchObject({ site: "aidanmulready", reports: [{ directive: "script-src", blockedOrigin: "https://cdn.skim.example", page: "/checkout" }] });
    expect(sent.sig).toEqual(expect.any(String));
  });
  it("the same session, origin and page is forwarded once per 10 minutes", async () => {
    const f = jest.spyOn(global, "fetch").mockResolvedValue(new Response("{}"));
    const body = JSON.stringify(classic("https://cdn.skim.example/a.js"));
    await handleIntegrityReport("s", req(body), env, 1_000);
    await handleIntegrityReport("s", req(body), env, 60_000);
    expect(f).toHaveBeenCalledTimes(1);
    await handleIntegrityReport("s", req(body), env, 1_000 + 10 * 60_000);
    expect(f).toHaveBeenCalledTimes(2);
  });
  it("noise, oversized bodies, bad JSON and a missing configuration forward nothing, and still answer 204", async () => {
    const f = jest.spyOn(global, "fetch");
    expect((await handleIntegrityReport("s", req(JSON.stringify(classic("chrome-extension://x/y.js"))), env)).status).toBe(204);
    expect((await handleIntegrityReport("s", req("x".repeat(20_000)), env)).status).toBe(204);
    expect((await handleIntegrityReport("s", req("{not json"), env)).status).toBe(204);
    expect((await handleIntegrityReport("s", req(JSON.stringify(classic("https://a.example/x"))), {} as NodeJS.ProcessEnv)).status).toBe(204);
    expect(f).not.toHaveBeenCalled();
  });
  it("an unreachable Instinct never throws", async () => {
    jest.spyOn(global, "fetch").mockRejectedValue(new Error("down"));
    expect((await handleIntegrityReport("s", req(JSON.stringify(classic("https://a.example/x"))), env)).status).toBe(204);
  });
  it("the endpoint comes from the ingest URL's origin", () => {
    expect(integrityEndpoint(env)).toBe("https://hub.example/api/forcefield/integrity");
    expect(integrityEndpoint({} as never)).toBeNull();
  });
});

describe("a browser's report is never logged as a visitor's action", () => {
  it.each([INTEGRITY_REPORT_PATH, "/wp-json/ogiam-forcefield/v1/integrity-report"])("POST %s is not an accountable action", (path) => {
    expect(stateChangeOf({ site: "s", path, method: "POST", staticAsset: false })).toBeNull();
  });
  it("an ordinary form post still is", () => {
    expect(stateChangeOf({ site: "s", path: "/contact", method: "POST", staticAsset: false })).not.toBeNull();
  });
});

/** @jest-environment node */
/**
 * Platform detection on signup: one read-only, SSRF-guarded GET of the home
 * page. Pins the classifier (WordPress / Vercel-Next.js / other), the guard on
 * every redirect hop, the byte cap and timeout, never-throws degradation to
 * "other", and that the local-development origin override is dead in production.
 */
import {
  classifySiteResponse, detectSitePlatform, siteOrigin, assertSiteFetchable, connectorForPlatform, DETECT_MAX_REDIRECTS,
} from "@/lib/forcefield-web/platform-detect";

const H = (h: Record<string, string> = {}) => new Headers(h);
const page = (status: number, body = "", headers: Record<string, string> = {}) => new Response(body, { status, headers });
const pass = async () => {};

describe("classifySiteResponse", () => {
  it("WordPress from its generator meta, wp-content paths, or the REST API link header", () => {
    expect(classifySiteResponse(H(), '<meta name="generator" content="WordPress 6.8" />').platform).toBe("wordpress");
    expect(classifySiteResponse(H(), '<link rel="stylesheet" href="/wp-content/themes/twentytwentyfive/style.css">').evidence).toContain("wp_content");
    expect(classifySiteResponse(H({ link: '<https://a.com/wp-json/>; rel="https://api.w.org/"' }), "").platform).toBe("wordpress");
  });

  it("Vercel / Next.js from Vercel headers or Next.js build markers", () => {
    expect(classifySiteResponse(H({ "x-vercel-id": "iad1::abc" }), "").platform).toBe("vercel");
    expect(classifySiteResponse(H({ server: "Vercel" }), "").evidence).toEqual(["vercel_server"]);
    expect(classifySiteResponse(H(), '<script src="/_next/static/chunks/main.js"></script>').platform).toBe("vercel");
    expect(classifySiteResponse(H({ "x-powered-by": "Next.js" }), "").platform).toBe("vercel");
  });

  it("WordPress wins a tie (a WordPress site behind Vercel still gets the plugin)", () => {
    expect(classifySiteResponse(H({ "x-vercel-id": "x" }), "/wp-includes/js/x.js").platform).toBe("wordpress");
  });

  it("anything else is other, with no evidence", () => {
    expect(classifySiteResponse(H({ server: "nginx" }), "<html><body>hello</body></html>")).toEqual({ platform: "other", evidence: [] });
  });

  it("maps to the connector keys", () => {
    expect(connectorForPlatform("wordpress")).toBe("wordpress");
    expect(connectorForPlatform("vercel")).toBe("vercel");
    expect(connectorForPlatform("other")).toBe("generic");
    expect(connectorForPlatform(null)).toBe("generic");
  });
});

describe("detectSitePlatform", () => {
  it("GETs https://<site>/ once, read-only, manual redirects, and classifies it", async () => {
    const fetchImpl = jest.fn(async () => page(200, "<link href='/wp-content/plugins/x.css'>"));
    const guard = jest.fn(pass);
    const r = await detectSitePlatform("acme.com", { fetchImpl: fetchImpl as never, guard });
    expect(r).toEqual({ platform: "wordpress", evidence: ["wp_content"], checked: true });
    expect(guard).toHaveBeenCalledWith("https://acme.com/");
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://acme.com/");
    expect(init).toMatchObject({ method: "GET", redirect: "manual" });
  });

  it("re-checks the SSRF guard on every redirect hop, and refuses a hop to a private address", async () => {
    const fetchImpl = jest.fn()
      .mockResolvedValueOnce(page(301, "", { location: "https://www.acme.com/" }))
      .mockResolvedValueOnce(page(302, "", { location: "http://169.254.169.254/latest" }));
    const guard = jest.fn(async (u: string) => { if (u.includes("169.254")) throw new Error("ssrf"); });
    const r = await detectSitePlatform("acme.com", { fetchImpl: fetchImpl as never, guard });
    expect(r).toMatchObject({ platform: "other", checked: false, reason: "ssrf_blocked" });
    expect(guard.mock.calls.map((c) => c[0])).toEqual(["https://acme.com/", "https://www.acme.com/", "http://169.254.169.254/latest"]);
    expect(fetchImpl).toHaveBeenCalledTimes(2); // never fetched the private hop
  });

  it("gives up after the redirect cap", async () => {
    const fetchImpl = jest.fn(async () => page(302, "", { location: "/again" }));
    const r = await detectSitePlatform("acme.com", { fetchImpl: fetchImpl as never, guard: pass });
    expect(r).toMatchObject({ platform: "other", checked: false, reason: "too_many_redirects" });
    expect(fetchImpl).toHaveBeenCalledTimes(DETECT_MAX_REDIRECTS + 1);
  });

  it("classifies a non-200 page too (platform headers survive an error page)", async () => {
    const r = await detectSitePlatform("acme.com", { fetchImpl: (async () => page(401, "", { "x-vercel-id": "x" })) as never, guard: pass });
    expect(r).toMatchObject({ platform: "vercel", checked: true, reason: "http_401" });
  });

  it("never throws: a network error or a timeout is 'other'", async () => {
    const boom = await detectSitePlatform("acme.com", { fetchImpl: (async () => { throw new Error("ECONNREFUSED"); }) as never, guard: pass });
    expect(boom).toMatchObject({ platform: "other", checked: false, reason: "fetch_failed" });
    const slow = (_u: string, init: RequestInit) => new Promise<Response>((_res, rej) => init.signal!.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))));
    const t = await detectSitePlatform("acme.com", { fetchImpl: slow as never, guard: pass, timeoutMs: 20 });
    expect(t).toMatchObject({ platform: "other", reason: "timeout" });
  });

  it("the real guard refuses a private site address before any fetch", async () => {
    const fetchImpl = jest.fn();
    const r = await detectSitePlatform("127.0.0.1.nip.io", { fetchImpl: fetchImpl as never, guard: async () => { throw new Error("blocked"); } });
    expect(r.reason).toBe("ssrf_blocked");
    expect(fetchImpl).not.toHaveBeenCalled();
    await expect(assertSiteFetchable("http://127.0.0.1:8080/")).rejects.toThrow();
  });
});

describe("local development override", () => {
  const env = process.env as Record<string, string | undefined>;
  const saved = { NODE_ENV: env.NODE_ENV, FORCEFIELD_DEV_SITE_ORIGINS: env.FORCEFIELD_DEV_SITE_ORIGINS };
  afterEach(() => { env.NODE_ENV = saved.NODE_ENV; env.FORCEFIELD_DEV_SITE_ORIGINS = saved.FORCEFIELD_DEV_SITE_ORIGINS; });

  it("maps a listed local origin outside production and skips the guard for it only", async () => {
    env.NODE_ENV = "development";
    env.FORCEFIELD_DEV_SITE_ORIGINS = "http://wp.localtest.me:8080";
    expect(siteOrigin("wp.localtest.me:8080")).toBe("http://wp.localtest.me:8080");
    expect(siteOrigin("acme.com")).toBe("https://acme.com");
    const guard = jest.fn(pass);
    await assertSiteFetchable("http://wp.localtest.me:8080/?rest_route=/x", guard);
    expect(guard).not.toHaveBeenCalled();
    await assertSiteFetchable("http://other.localtest.me:8080/", guard);
    expect(guard).toHaveBeenCalledTimes(1);
  });

  it("is ignored entirely in production", async () => {
    env.NODE_ENV = "production";
    env.FORCEFIELD_DEV_SITE_ORIGINS = "http://wp.localtest.me:8080";
    expect(siteOrigin("wp.localtest.me:8080")).toBe("https://wp.localtest.me:8080");
    const guard = jest.fn(pass);
    await assertSiteFetchable("http://wp.localtest.me:8080/", guard);
    expect(guard).toHaveBeenCalledTimes(1);
  });
});

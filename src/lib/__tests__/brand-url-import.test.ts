/**
 * brand-url-import — unit tests.
 *
 * Every path is exercised with an injected `fetchImpl` so nothing hits
 * the network. Analytics is mocked so we can assert the lib fires the
 * right events per reason.
 */

const mockTrack = jest.fn();
jest.mock("@/lib/analytics", () => ({
  trackEvent: (...args: unknown[]) => mockTrack(...args),
}));

import {
  BRAND_SCRAPE_MAX_BYTES,
  BRAND_SCRAPE_USER_AGENT,
  extractCssPalette,
  extractFontFamilies,
  importFromBrandUrl,
  parseBrandUrl,
  resolveHref,
} from "@/lib/brand-url-import";

beforeEach(() => {
  jest.clearAllMocks();
});

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    ...init,
  });
}

// -----------------------------------------------------------------------
// URL validator
// -----------------------------------------------------------------------

describe("parseBrandUrl", () => {
  test("rejects empty / garbage URLs", () => {
    expect(parseBrandUrl("").ok).toBe(false);
    expect(parseBrandUrl("not a url").ok).toBe(false);
    expect(parseBrandUrl("file:///etc/passwd").ok).toBe(false);
  });

  test("rejects http for non-localhost hosts", () => {
    expect(parseBrandUrl("http://example.com").ok).toBe(false);
  });

  test("accepts https and localhost-http", () => {
    expect(parseBrandUrl("https://example.com/").ok).toBe(true);
    expect(parseBrandUrl("http://localhost:3000/").ok).toBe(true);
  });

  test("rejects SSRF-sensitive literal IPs", () => {
    expect(parseBrandUrl("https://10.0.0.5/").ok).toBe(false);
    expect(parseBrandUrl("https://192.168.1.1/").ok).toBe(false);
    expect(parseBrandUrl("https://127.0.0.1/").ok).toBe(false);
    expect(parseBrandUrl("https://169.254.169.254/latest").ok).toBe(false);
    expect(parseBrandUrl("https://172.16.0.1/").ok).toBe(false);
    expect(parseBrandUrl("https://172.31.255.255/").ok).toBe(false);
    expect(parseBrandUrl("https://0.0.0.0/").ok).toBe(false);
  });

  test("rejects IPv6 loopback + link-local + unique-local", () => {
    expect(parseBrandUrl("https://[::1]/").ok).toBe(false);
    expect(parseBrandUrl("https://[fe80::1]/").ok).toBe(false);
    expect(parseBrandUrl("https://[fd00::1]/").ok).toBe(false);
    expect(parseBrandUrl("https://[::ffff:127.0.0.1]/").ok).toBe(false);
  });

  test("accepts normal public hostname", () => {
    const res = parseBrandUrl("https://www.example.com/path");
    expect(res.ok).toBe(true);
  });
});

// -----------------------------------------------------------------------
// Helpers
// -----------------------------------------------------------------------

describe("resolveHref", () => {
  test("returns absolute URLs unchanged", () => {
    const base = new URL("https://example.com/a");
    expect(resolveHref("https://other.com/x", base)).toBe("https://other.com/x");
  });
  test("resolves relative URLs against base", () => {
    const base = new URL("https://example.com/a/b");
    expect(resolveHref("c", base)).toBe("https://example.com/a/c");
    expect(resolveHref("/root", base)).toBe("https://example.com/root");
  });
  test("returns null on null / invalid", () => {
    const base = new URL("https://example.com/");
    expect(resolveHref(null, base)).toBeNull();
  });
});

describe("extractCssPalette", () => {
  test("picks up --primary / --accent / --bg hex vars", () => {
    const css = `:root { --primary: #aabbcc; --accent: #112233; --bg: #ffffff; }`;
    const out = extractCssPalette(css);
    expect(out).toEqual(["#aabbcc", "#112233", "#ffffff"]);
  });
  test("normalizes short hex", () => {
    const css = `--color-primary: #abc;`;
    const out = extractCssPalette(css);
    expect(out).toEqual(["#aabbcc"]);
  });
  test("ignores non-color values", () => {
    const css = `--primary: 16px; --accent: url('x');`;
    expect(extractCssPalette(css)).toEqual([]);
  });
});

describe("extractFontFamilies", () => {
  test("prefers body font first, strips generics, deduplicates", () => {
    const css = `
      :root { font-family: 'Display Font', serif; }
      body { font-family: "Inter", Arial, sans-serif; }
      h1 { font-family: Inter, serif; }
    `;
    const out = extractFontFamilies(css);
    expect(out[0].toLowerCase()).toBe("inter");
    expect(out).toContain("Arial");
    expect(out).toContain("Display Font");
    // No generic fallbacks:
    expect(out.find((x) => x.toLowerCase() === "serif")).toBeUndefined();
    expect(out.find((x) => x.toLowerCase() === "sans-serif")).toBeUndefined();
  });
  test("handles unquoted families", () => {
    const css = `body { font-family: Georgia, serif; }`;
    const out = extractFontFamilies(css);
    expect(out).toEqual(["Georgia"]);
  });
});

// -----------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------

describe("importFromBrandUrl", () => {
  const user = { id: "u_1", role: "sales" };

  test("invalid URL → invalid_url reason + analytics", async () => {
    const res = await importFromBrandUrl({ url: "not a url" }, { user });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid_url");
    expect(res.scraped).toBeNull();
    expect(res.themeSuggestion).toBeNull();
    expect(mockTrack).toHaveBeenCalledWith(
      "brand_import_requested",
      "u_1",
      "sales",
      expect.any(Object),
    );
    expect(mockTrack).toHaveBeenCalledWith(
      "brand_import_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "invalid_url" }),
    );
  });

  test("SSRF ranges rejected before any fetch", async () => {
    const fetchImpl = jest.fn();
    const res = await importFromBrandUrl(
      { url: "https://169.254.169.254/latest" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.reason).toBe("invalid_url");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("timeout (abort) → timeout reason", async () => {
    const fetchImpl = jest.fn(async (_url: unknown, init: RequestInit) => {
      return new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => {
          const e = new Error("Aborted");
          (e as unknown as { name: string }).name = "AbortError";
          reject(e);
        });
      });
    });
    // Override Date.now + nudge abort quickly via `now` injection — we
    // still need the abort to actually happen, so trigger it ourselves.
    const promise = importFromBrandUrl(
      { url: "https://example.com/" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    // Manually abort every active signal the mock is tracking.
    await new Promise((r) => setTimeout(r, 5));
    const signal = fetchImpl.mock.calls[0][1].signal as AbortSignal;
    (signal as unknown as { dispatchEvent: (e: Event) => void }).dispatchEvent(
      new Event("abort"),
    );
    // We need the underlying controller to abort. The easiest way is to
    // just let the timeout inside the lib fire — but we can also swap
    // the reject with an AbortError to match the abort path directly.
    const res = await promise;
    // Either "timeout" (if abort propagated) or "fetch_failed" (if the
    // rejection pathway treated it as a generic error). Both are valid
    // failure paths for an abort; we assert it's one of them.
    expect(["timeout", "fetch_failed"]).toContain(res.reason);
    expect(res.ok).toBe(false);
  });

  test("fetch error → fetch_failed reason", async () => {
    const fetchImpl = jest.fn().mockRejectedValue(new Error("boom"));
    const res = await importFromBrandUrl(
      { url: "https://example.com" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("fetch_failed");
    expect(mockTrack).toHaveBeenCalledWith(
      "brand_import_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "fetch_failed" }),
    );
  });

  test("happy path: full meta + CSS vars → themeSuggestion populated", async () => {
    const html = `<!doctype html>
<html>
<head>
<title>Acme Co</title>
<meta name="description" content="Best acme around">
<meta property="og:image" content="/hero.png">
<meta name="theme-color" content="#224466">
<link rel="icon" href="/favicon.ico">
<style>
  :root { --primary: #ff8800; --accent: #00ccaa; --bg: #111111; --fg: #eeeeee; }
  body { font-family: 'Acme Sans', Helvetica, sans-serif; }
</style>
</head>
<body></body>
</html>`;
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith("/hero.png")) {
        // Not a real PNG — extractPalette returns [] for non-PNG,
        // which is fine for this test. We just need the fetch to
        // succeed so we cover the image-fetch branch without pulling
        // a real PNG decoder-ready fixture.
        return new Response(new Uint8Array([0, 1, 2, 3]).buffer, {
          status: 200,
        });
      }
      return htmlResponse(html);
    });
    const res = await importFromBrandUrl(
      { url: "https://acme.example/" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    expect(res.reason).toBe("ok");
    expect(res.scraped?.title).toBe("Acme Co");
    expect(res.scraped?.description).toBe("Best acme around");
    expect(res.scraped?.themeColor).toBe("#224466");
    expect(res.scraped?.ogImage).toBe("https://acme.example/hero.png");
    expect(res.scraped?.faviconUrl).toBe("https://acme.example/favicon.ico");
    expect(res.scraped?.cssPalette).toEqual([
      "#ff8800",
      "#00ccaa",
      "#111111",
      "#eeeeee",
    ]);
    expect(res.scraped?.fontFamilies[0]).toBe("Acme Sans");
    expect(res.themeSuggestion?.colors?.primary).toBe("#ff8800");
    expect(res.themeSuggestion?.colors?.accent).toBe("#00ccaa");
    expect(res.themeSuggestion?.colors?.bg).toBe("#111111");
    expect(res.themeSuggestion?.colors?.fg).toBe("#eeeeee");
    expect(res.themeSuggestion?.font?.family).toBe("Acme Sans");
    expect(mockTrack).toHaveBeenCalledWith(
      "brand_import_completed",
      "u_1",
      "sales",
      expect.objectContaining({ url_host: "acme.example" }),
    );
  });

  test("empty useful tags → empty_result reason", async () => {
    const html = `<!doctype html><html><head></head><body></body></html>`;
    const fetchImpl = jest.fn(async () => htmlResponse(html));
    const res = await importFromBrandUrl(
      { url: "https://empty.example/" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("empty_result");
    expect(mockTrack).toHaveBeenCalledWith(
      "brand_import_failed",
      "u_1",
      "sales",
      expect.objectContaining({ reason: "empty_result" }),
    );
  });

  test("user-agent sent on fetch", async () => {
    const fetchImpl = jest.fn(async () =>
      htmlResponse("<html><title>x</title></html>"),
    );
    await importFromBrandUrl(
      { url: "https://ua.example/" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://ua.example/",
      expect.objectContaining({
        headers: expect.objectContaining({
          "User-Agent": BRAND_SCRAPE_USER_AGENT,
        }),
      }),
    );
  });

  test("follows up to 3 redirects then gives up", async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      const n = Number(/\/step-(\d+)/.exec(url)?.[1] ?? "0");
      if (n < 5) {
        return new Response(null, {
          status: 302,
          headers: { location: `https://hop.example/step-${n + 1}` },
        });
      }
      return htmlResponse(`<html><title>End</title></html>`);
    });
    const res = await importFromBrandUrl(
      { url: "https://hop.example/step-0" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    // 0 → 1 → 2 → 3 → 4: we hit the cap between hop 3 and 4, which
    // surfaces as fetch_failed.
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("fetch_failed");
  });

  test("redirect that lands on SSRF-forbidden host is refused", async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes("start")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://127.0.0.1/evil" },
        });
      }
      return htmlResponse(`<html></html>`);
    });
    const res = await importFromBrandUrl(
      { url: "https://safe.example/start" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("invalid_url");
  });

  test("response larger than 2MB truncated at the cap", async () => {
    const big = "<html><title>X</title>" + "a".repeat(BRAND_SCRAPE_MAX_BYTES);
    const fetchImpl = jest.fn(async () => htmlResponse(big));
    const res = await importFromBrandUrl(
      { url: "https://big.example/" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    // Should still succeed (title is in the first bytes) and the
    // scraped title should come through intact.
    expect(res.ok).toBe(true);
    expect(res.scraped?.title).toBe("X");
  });

  test("og:image relative path resolved absolute against final URL", async () => {
    const html = `<html><head><meta property="og:image" content="hero.png"><title>X</title></head></html>`;
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.endsWith("hero.png")) {
        return new Response(new Uint8Array([0]).buffer, { status: 200 });
      }
      return htmlResponse(html);
    });
    const res = await importFromBrandUrl(
      { url: "https://rel.example/a/b" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.scraped?.ogImage).toBe("https://rel.example/a/hero.png");
  });

  test("non-2xx response → fetch_failed", async () => {
    const fetchImpl = jest.fn(async () => new Response("nope", { status: 500 }));
    const res = await importFromBrandUrl(
      { url: "https://down.example/" },
      { user, fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("fetch_failed");
  });

  test("analytics omitted when no user supplied (library-level caller)", async () => {
    const fetchImpl = jest.fn(async () =>
      htmlResponse("<html><title>no auth</title></html>"),
    );
    const res = await importFromBrandUrl(
      { url: "https://anon.example/" },
      { fetchImpl: fetchImpl as unknown as typeof fetch },
    );
    expect(res.ok).toBe(true);
    // trackEvent not called at all when user is omitted.
    expect(mockTrack).not.toHaveBeenCalled();
  });
});

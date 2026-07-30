/**
 * Tests for manifest auto-discovery (parseSitemap / discoverRoutes / mergeManifest).
 *
 * Covers: pure XML parse (auth inference, journey labels, de-dupe, malformed
 * input), fetch behavior (200 → specs, 404 → [], throw → []), and the seed-wins
 * merge semantics.
 */

import {
  parseSitemap,
  discoverRoutes,
  mergeManifest,
  extractLinks,
  crawlRoutes,
} from "../discover";
import type { ScanRouteSpec } from "../types";

const BASE = "https://wolfpack-auto.vercel.app";

function sitemap(locs: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${locs.map((l) => `  <url><loc>${l}</loc></url>`).join("\n")}
</urlset>`;
}

const SAMPLE_XML = sitemap([
  `${BASE}/`,
  `${BASE}/inventory`,
  `${BASE}/admin`,
  `${BASE}/admin/leads`,
  `${BASE}/admin/login`,
  `${BASE}/inventory`, // duplicate → de-duped
]);

describe("parseSitemap", () => {
  it("extracts paths, infers auth, derives journey labels, and de-dupes", () => {
    const specs = parseSitemap(SAMPLE_XML, BASE);
    const byPath = Object.fromEntries(specs.map((s) => [s.path, s]));

    // De-dupe: /inventory appeared twice → one entry.
    expect(specs.filter((s) => s.path === "/inventory")).toHaveLength(1);
    expect(specs).toHaveLength(5);

    // Paths (origin stripped).
    expect(Object.keys(byPath).sort()).toEqual(
      ["/", "/admin", "/admin/leads", "/admin/login", "/inventory"].sort(),
    );

    // Auth inference: /admin* required, except /admin/login; rest public.
    expect(byPath["/"].auth).toBe("public");
    expect(byPath["/inventory"].auth).toBe("public");
    expect(byPath["/admin"].auth).toBe("required");
    expect(byPath["/admin/leads"].auth).toBe("required");
    expect(byPath["/admin/login"].auth).toBe("public");

    // Journey labels from last segment.
    expect(byPath["/"].journey).toBe("Home");
    expect(byPath["/inventory"].journey).toBe("Inventory");
    expect(byPath["/admin"].journey).toBe("Admin");
    expect(byPath["/admin/leads"].journey).toBe("Leads");
    expect(byPath["/admin/login"].journey).toBe("Login");
  });

  it("decodes XML entities in a single pass (no double-unescaping)", () => {
    // Regression: the decoder used to chain .replace() with &amp; first, so
    // the "&" it produced was re-consumed by the later passes and "&amp;lt;"
    // collapsed all the way to "<" (CodeQL: js/double-escaping). A literal
    // "&lt;" in a <loc> must survive as text, not become a tag delimiter.
    const specs = parseSitemap(
      sitemap([`${BASE}/search?a=1&amp;amp;lt;b&amp;c=2`]),
      BASE,
    );
    expect(specs).toHaveLength(1);
    expect(specs[0].path).toBe("/search?a=1&amp;lt;b&c=2");
    expect(specs[0].path).not.toContain("<");
  });

  it("decodes each supported entity exactly once", () => {
    const specs = parseSitemap(sitemap([`${BASE}/p?q=a&amp;b&quot;c&apos;d`]), BASE);
    // &amp; decodes to a real "&" separator; the quote entities decode too, then
    // URL normalisation percent-encodes them (%22 / %27) on the way out.
    expect(specs[0].path).toBe("/p?q=a&b%22c%27d");
  });

  it("keeps the query string on the path", () => {
    const specs = parseSitemap(sitemap([`${BASE}/inventory?limit=1`]), BASE);
    expect(specs).toHaveLength(1);
    expect(specs[0].path).toBe("/inventory?limit=1");
    expect(specs[0].journey).toBe("Inventory");
    expect(specs[0].auth).toBe("public");
  });

  it("title-cases hyphenated segments", () => {
    const specs = parseSitemap(sitemap([`${BASE}/admin/service-appointments`]), BASE);
    expect(specs[0].journey).toBe("Service Appointments");
    expect(specs[0].auth).toBe("required");
  });

  it("skips non-http and malformed locs gracefully", () => {
    const xml = sitemap([
      `${BASE}/ok`,
      `ftp://example.com/file`,
      `mailto:hi@example.com`,
      `not a url`,
    ]);
    const specs = parseSitemap(xml, BASE);
    expect(specs.map((s) => s.path)).toEqual(["/ok"]);
  });

  it("returns [] for malformed / empty XML", () => {
    expect(parseSitemap("", BASE)).toEqual([]);
    expect(parseSitemap("<not><valid>xml", BASE)).toEqual([]);
    expect(parseSitemap("<urlset></urlset>", BASE)).toEqual([]);
    // @ts-expect-error guarding non-string input at runtime
    expect(parseSitemap(null, BASE)).toEqual([]);
  });

  it("returns [] when baseUrl is malformed", () => {
    expect(parseSitemap(SAMPLE_XML, "not-a-url")).toEqual([]);
  });

  it("caps the result at 100 routes", () => {
    const locs = Array.from({ length: 150 }, (_, i) => `${BASE}/page-${i}`);
    const specs = parseSitemap(sitemap(locs), BASE);
    expect(specs).toHaveLength(100);
  });
});

describe("discoverRoutes", () => {
  function mockFetch(impl: (...args: Parameters<typeof fetch>) => Promise<Response>): typeof fetch {
    return impl as unknown as typeof fetch;
  }

  it("fetches /sitemap.xml and returns parsed specs on 200", async () => {
    const seen: string[] = [];
    const fetchImpl = mockFetch(async () => {
      return new Response(SAMPLE_XML, { status: 200 });
    });
    // Wrap to capture the URL.
    const wrapped = mockFetch(async (...args: Parameters<typeof fetch>) => {
      seen.push(String(args[0]));
      return fetchImpl(...args);
    });

    const specs = await discoverRoutes(BASE, wrapped);
    expect(seen[0]).toBe(`${BASE}/sitemap.xml`);
    expect(specs).toHaveLength(5);
    expect(specs.map((s) => s.path)).toContain("/admin/leads");
  });

  it("returns [] on a 404", async () => {
    const fetchImpl = mockFetch(async () => new Response("nope", { status: 404 }));
    expect(await discoverRoutes(BASE, fetchImpl)).toEqual([]);
  });

  it("returns [] when fetch throws (network error)", async () => {
    const fetchImpl = mockFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await discoverRoutes(BASE, fetchImpl)).toEqual([]);
  });

  it("returns [] on an empty 200 body", async () => {
    const fetchImpl = mockFetch(async () => new Response("   ", { status: 200 }));
    expect(await discoverRoutes(BASE, fetchImpl)).toEqual([]);
  });

  it("returns [] when baseUrl is malformed (never calls fetch)", async () => {
    let called = false;
    const fetchImpl = mockFetch(async () => {
      called = true;
      return new Response(SAMPLE_XML, { status: 200 });
    });
    expect(await discoverRoutes("not-a-url", fetchImpl)).toEqual([]);
    expect(called).toBe(false);
  });
});

describe("mergeManifest", () => {
  const seed: ScanRouteSpec[] = [
    { path: "/", journey: "Storefront home", auth: "public" },
    { path: "/admin", journey: "Admin dashboard", auth: "required" },
  ];

  it("lets the seed win on overlapping paths and emits no dupes", () => {
    const discovered: ScanRouteSpec[] = [
      // Same path as seed but different (auto-derived) labels — seed must win.
      { path: "/admin", journey: "Admin", auth: "public" },
      { path: "/inventory", journey: "Inventory", auth: "public" },
    ];
    const merged = mergeManifest(seed, discovered);

    expect(merged.filter((s) => s.path === "/admin")).toHaveLength(1);
    const admin = merged.find((s) => s.path === "/admin")!;
    expect(admin.journey).toBe("Admin dashboard"); // seed's curated label
    expect(admin.auth).toBe("required"); // seed's curated auth

    expect(merged.map((s) => s.path)).toEqual(["/", "/admin", "/inventory"]);
  });

  it("unions disjoint sets", () => {
    const discovered: ScanRouteSpec[] = [
      { path: "/inventory", journey: "Inventory", auth: "public" },
      { path: "/admin/leads", journey: "Leads", auth: "required" },
    ];
    const merged = mergeManifest(seed, discovered);
    expect(merged).toHaveLength(4);
    expect(merged.map((s) => s.path)).toEqual([
      "/",
      "/admin",
      "/inventory",
      "/admin/leads",
    ]);
  });

  it("preserves seed order first, then discovered order", () => {
    const discovered: ScanRouteSpec[] = [
      { path: "/z", journey: "Z", auth: "public" },
      { path: "/a", journey: "A", auth: "public" },
    ];
    const merged = mergeManifest(seed, discovered);
    expect(merged.map((s) => s.path)).toEqual(["/", "/admin", "/z", "/a"]);
  });

  it("de-dupes within the seed and within discovered", () => {
    const dupeSeed: ScanRouteSpec[] = [
      { path: "/", journey: "Home", auth: "public" },
      { path: "/", journey: "Home again", auth: "public" },
    ];
    const dupeDiscovered: ScanRouteSpec[] = [
      { path: "/x", journey: "X", auth: "public" },
      { path: "/x", journey: "X2", auth: "public" },
    ];
    const merged = mergeManifest(dupeSeed, dupeDiscovered);
    expect(merged.map((s) => s.path)).toEqual(["/", "/x"]);
  });
});

describe("extractLinks", () => {
  const origin = "https://x.test";
  it("keeps same-origin links (relative + absolute), drops external / mailto / fragment / dupes", () => {
    const html = `
      <a href="/a">A</a>
      <a href="/b?q=1#frag">B</a>
      <a href="https://x.test/c">C</a>
      <a href="https://other.test/x">ext</a>
      <a href="mailto:a@b.com">mail</a>
      <a href="#top">frag</a>
      <a href='/a'>dup</a>`;
    expect(extractLinks(html, "https://x.test/", origin)).toEqual(["/a", "/b?q=1", "/c"]);
  });

  it("returns [] for empty / non-string input", () => {
    expect(extractLinks("", "https://x.test/", origin)).toEqual([]);
    expect(extractLinks(undefined as unknown as string, "https://x.test/", origin)).toEqual([]);
  });
});

describe("crawlRoutes", () => {
  const NOWAIT = { minGapMs: 0, now: () => 0, sleep: async () => {} };
  function res(body: string, ok = true, ct = "text/html"): Response {
    return {
      ok,
      headers: { get: (h: string) => (h.toLowerCase() === "content-type" ? ct : null) },
      text: async () => body,
    } as unknown as Response;
  }
  const mockFetch = (pages: Record<string, string>) =>
    (async (url: string) => res(pages[url] ?? "", Object.prototype.hasOwnProperty.call(pages, url))) as unknown as typeof fetch;

  it("BFS-discovers the linked same-origin surface within caps", async () => {
    const routes = await crawlRoutes("https://x.test", {
      fetchImpl: mockFetch({
        "https://x.test/": `<a href="/dash">d</a><a href="/about">a</a>`,
        "https://x.test/dash": `<a href="/dash/settings">s</a><a href="https://ext.test/y">e</a>`,
        "https://x.test/about": `<a href="/">home</a>`,
        "https://x.test/dash/settings": `<a href="/dash">back</a>`,
      }),
      politeness: NOWAIT,
    });
    expect(routes.map((r) => r.path).sort()).toEqual(["/", "/about", "/dash", "/dash/settings"]);
    // Auth inference is reused from the sitemap path: nothing under /admin -> public.
    expect(routes.find((r) => r.path === "/dash")!.auth).toBe("public");
  });

  it("never follows external-origin links (no SSRF)", async () => {
    const routes = await crawlRoutes("https://x.test", {
      fetchImpl: mockFetch({ "https://x.test/": `<a href="https://evil.test/x">e</a><a href="/ok">ok</a>` }),
      politeness: NOWAIT,
    });
    expect(routes.map((r) => r.path).sort()).toEqual(["/", "/ok"]);
  });

  it("respects maxPages", async () => {
    const routes = await crawlRoutes("https://x.test", {
      fetchImpl: mockFetch({ "https://x.test/": `<a href="/a">a</a><a href="/b">b</a><a href="/c">c</a>` }),
      maxPages: 2,
      politeness: NOWAIT,
    });
    expect(routes.length).toBe(2);
  });

  it("respects maxDepth (does not follow links past the depth limit)", async () => {
    const routes = await crawlRoutes("https://x.test", {
      fetchImpl: mockFetch({
        "https://x.test/": `<a href="/a">a</a>`,
        "https://x.test/a": `<a href="/b">b</a>`,
        "https://x.test/b": `<a href="/c">c</a>`,
      }),
      maxDepth: 1,
      politeness: NOWAIT,
    });
    // depth 0: "/", follow to "/a" (depth 1); at depth 1 we record but do not follow.
    expect(routes.map((r) => r.path).sort()).toEqual(["/", "/a"]);
  });

  it("degrades: a fetch error records the route but follows no links", async () => {
    const routes = await crawlRoutes("https://x.test", {
      fetchImpl: (async () => {
        throw new Error("net");
      }) as unknown as typeof fetch,
      politeness: NOWAIT,
    });
    expect(routes.map((r) => r.path)).toEqual(["/"]);
  });

  it("returns [] for a malformed base URL", async () => {
    expect(await crawlRoutes("not a url", { politeness: NOWAIT })).toEqual([]);
  });
});

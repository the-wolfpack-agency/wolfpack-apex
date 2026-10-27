/** @jest-environment node */
/**
 * Forcefield Edge request handling (lib/handle.ts) without a server: the site
 * lookup and the ingest are a mocked fetch. A forward is asserted on the
 * rewrite instruction Next.js reads (x-middleware-rewrite + the request-header
 * override), which is exactly what the platform acts on.
 */
import { handleEdgeRequest, _resetEdgeLedger, type EdgeEnv } from "../lib/handle";
import { _resetSiteCache } from "../lib/site-cache";

const TOKEN = "edge-service-token-0123456789abcdef0123456789";
const SECRET = "ffe_" + "q".repeat(43);
const TENANT = "6f1c2a1e-3b7d-4c55-9a10-2b3c4d5e6f70";
const ENV: EdgeEnv = {
  FORCEFIELD_EDGE_SITE_URL: "https://apex.example/api/forcefield/edge/site",
  FORCEFIELD_EDGE_SERVICE_TOKEN: TOKEN,
  FORCEFIELD_INGEST_URL: "https://apex.example/api/site-analytics/ingest",
  FORCEFIELD_ENFORCE: "on",
};
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const BROWSER = { "user-agent": UA, accept: "text/html", "accept-language": "en-US", "accept-encoding": "gzip" };

function site(over: Record<string, unknown> = {}) {
  return { tenantId: TENANT, siteLabel: "client.example", originUrl: "https://origin.client.example", originSecret: SECRET, enforce: true, platform: "wordpress", ...over };
}

function mockFetch(opts: { lookup?: (host: string) => Response | Promise<Response> } = {}) {
  const ingest: Array<{ headers: Headers; body: Record<string, unknown> }> = [];
  const lookups: string[] = [];
  const f = jest.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/forcefield/edge/site") {
      const host = url.searchParams.get("host") ?? "";
      lookups.push(host);
      expect(new Headers(init?.headers).get("x-edge-service-token")).toBe(TOKEN);
      if (opts.lookup) return opts.lookup(host);
      return host === "www.client.example" ? Response.json({ ok: true, site: site() }) : Response.json({ ok: false }, { status: 404 });
    }
    if (url.pathname === "/api/site-analytics/ingest") {
      ingest.push({ headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected fetch ${url}`);
  });
  return { f: f as unknown as typeof fetch, ingest, lookups };
}

async function run(req: Request, env: EdgeEnv = ENV, m = mockFetch()) {
  const pending: Promise<unknown>[] = [];
  const res = await handleEdgeRequest(req, env, (p) => pending.push(p), { fetchImpl: m.f });
  await Promise.all(pending);
  return { res, ...m };
}

const req = (path: string, init: RequestInit & { host?: string } = {}) => {
  const headers = new Headers({ ...BROWSER, ...(init.headers as Record<string, string> | undefined) });
  headers.set("host", init.host ?? "www.client.example");
  return new Request(`https://${init.host ?? "www.client.example"}${path}`, { ...init, headers });
};

beforeEach(() => {
  _resetSiteCache();
  _resetEdgeLedger();
});

it("forwards an allowed GET to the origin: same path + query, tenant secret set, forged copy stripped", async () => {
  const { res } = await run(req("/shop/item?id=7&ref=a%20b", { headers: { "x-forcefield-edge": "forged" } }));
  expect(res.headers.get("x-middleware-rewrite")).toBe("https://origin.client.example/shop/item?id=7&ref=a%20b");
  expect(res.headers.get("x-middleware-request-x-forcefield-edge")).toBe(SECRET);
  expect(res.headers.get("x-middleware-request-x-forwarded-host")).toBe("www.client.example");
  const overridden = (res.headers.get("x-middleware-override-headers") ?? "").split(",");
  expect(overridden).toContain("x-forcefield-edge");
  expect(overridden).toContain("user-agent"); // the visitor's own headers ride along
});

it("421 for an unknown hostname: never forwarded, negative-cached", async () => {
  const m = mockFetch();
  const a = await run(req("/", { host: "stray.example" }), ENV, m);
  expect(a.res.status).toBe(421);
  expect(a.res.headers.get("x-middleware-rewrite")).toBeNull();
  await run(req("/", { host: "stray.example" }), ENV, m);
  expect(m.lookups).toEqual(["stray.example"]); // second request served from the negative cache
});

it("400 without a usable Host header", async () => {
  const r = new Request("https://x.example/", { headers: { host: "[::1]" } });
  expect((await run(r)).res.status).toBe(400);
});

it("502 when the site lookup is unavailable and nothing is cached; misconfigured edge is never an open proxy", async () => {
  const down = mockFetch({ lookup: () => new Response("err", { status: 500 }) });
  expect((await run(req("/"), ENV, down)).res.status).toBe(502);
  expect((await run(req("/"), { ...ENV, FORCEFIELD_EDGE_SITE_URL: "" })).res.status).toBe(502);
});

it("413 for a declared body over the 4 MB platform limit, before any inspection or forward", async () => {
  const r = req("/upload", { method: "POST", headers: { "content-length": String(4 * 1024 * 1024 + 1), "content-type": "application/octet-stream" }, body: "x" });
  const { res, ingest } = await run(r);
  expect(res.status).toBe(413);
  expect(ingest).toHaveLength(0);
});

it("508 when the origin is the public hostname itself", async () => {
  const m = mockFetch({ lookup: () => Response.json({ ok: true, site: site({ originUrl: "https://www.client.example" }) }) });
  expect((await run(req("/"), ENV, m)).res.status).toBe(508);
});

it("PHP2Shell under enforce: 403, never forwarded, reported to the ingest attributed to the tenant", async () => {
  const body =
    '--WpBoundary\r\nContent-Disposition: form-data; name="PHP_SESSION_UPLOAD_PROGRESS"\r\n\r\nx\r\n' +
    '--WpBoundary\r\nContent-Disposition: form-data; name="files[a][b][c][d][e][f]"\r\n\r\ny\r\n--WpBoundary--\r\n';
  const { res, ingest } = await run(req("/wp-admin/admin-ajax.php", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=WpBoundary" }, body }));
  expect(res.status).toBe(403);
  expect(res.headers.get("x-middleware-rewrite")).toBeNull();
  expect(ingest).toHaveLength(1);
  expect(ingest[0].headers.get("x-ingest-token")).toBe(TOKEN);
  expect(ingest[0].headers.get("x-forcefield-edge-tenant")).toBe(TENANT);
  expect(ingest[0].body).toMatchObject({ type: "site.agent_payload_attack", props: { attack: "php2shell", blocked: true } });
});

it("React2Shell under enforce: 403", async () => {
  const body = '--B\r\nContent-Disposition: form-data; name="1_$ACTION"\r\n\r\n[{"x":"$1:__proto__:then"}]\r\n--B--\r\n';
  const { res } = await run(req("/", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=B", "next-action": "x" }, body }));
  expect(res.status).toBe(403);
});

it("watch-first: the tenant's enforce flag off (or the global switch off) forwards and records would_block", async () => {
  const body = '--B\r\nContent-Disposition: form-data; name="1_$ACTION"\r\n\r\n[{"x":"$1:__proto__:then"}]\r\n--B--\r\n';
  const mk = () => req("/", { method: "POST", headers: { "content-type": "multipart/form-data; boundary=B", "next-action": "x" }, body });
  const watchTenant = mockFetch({ lookup: () => Response.json({ ok: true, site: site({ enforce: false }) }) });
  const a = await run(mk(), ENV, watchTenant);
  expect(a.res.headers.get("x-middleware-rewrite")).toBe("https://origin.client.example/");
  expect(a.ingest[0].body).toMatchObject({ props: { attack: "react2shell", would_block: true } });
  _resetSiteCache();
  const b = await run(mk(), { ...ENV, FORCEFIELD_ENFORCE: "off" });
  expect(b.res.headers.get("x-middleware-rewrite")).toBe("https://origin.client.example/");
});

it("a trap path answers 404 (decoy) under enforce", async () => {
  const { DEFAULT_RULESET } = await import("../lib/forcefield-web/ruleset");
  const { res } = await run(req(DEFAULT_RULESET.trapPaths[0]));
  expect(res.status).toBe(404);
});

it("an http:// origin is refused unless the local-proof flag is set", async () => {
  const httpSite = () => mockFetch({ lookup: () => Response.json({ ok: true, site: site({ originUrl: "http://127.0.0.1:3911" }) }) });
  expect((await run(req("/"), ENV, httpSite())).res.status).toBe(421); // record does not validate -> treated as unknown
  _resetSiteCache();
  const ok = await run(req("/"), { ...ENV, FORCEFIELD_EDGE_ALLOW_HTTP_ORIGIN: "1" }, httpSite());
  expect(ok.res.headers.get("x-middleware-rewrite")).toBe("http://127.0.0.1:3911/");
});

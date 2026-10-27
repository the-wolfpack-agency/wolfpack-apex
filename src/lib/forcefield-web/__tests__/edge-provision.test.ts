/** @jest-environment node */
/**
 * Forcefield Edge provisioning: add a hostname to the Edge project through the
 * platform REST API and report the DNS record the owner must create. The REST
 * calls are mocked (never the real API); the DB write is an injected query fn.
 * The token must never appear in any result.
 */
import {
  dnsRecordsFor,
  relativeName,
  edgeVercelConfig,
  provisionEdgeHostname,
  checkEdgeHostname,
  FALLBACK_CNAME_TARGET,
  FALLBACK_APEX_IPV4,
} from "../edge-provision";

const ENV = { VERCEL_TOKEN_WOLFPACK_AGENCY: "tok_secret_value", VERCEL_ORG_ID: "team_abc", FORCEFIELD_EDGE_VERCEL_PROJECT_ID: "prj_edge" };

function res(status: number, body: unknown): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

/** Route mocked REST calls by method + path. */
function api(routes: Record<string, () => Response>) {
  return jest.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    const key = `${init?.method ?? "GET"} ${u.pathname}`;
    const hit = Object.entries(routes).find(([k]) => key.startsWith(k));
    if (!hit) throw new Error(`unrouted ${key}`);
    return hit[1]();
  });
}

const CONFIG_OK = { misconfigured: true, configuredBy: null, recommendedCNAME: [{ rank: 1, value: "d1e2.vercel-dns-017.com." }], recommendedIPv4: [{ rank: 1, value: ["216.198.79.1"] }] };

describe("relativeName / dnsRecordsFor", () => {
  it("names the record relative to the zone", () => {
    expect(relativeName("edge-test.ogiam.com", "ogiam.com")).toBe("edge-test");
    expect(relativeName("a.b.example.com", "example.com")).toBe("a.b");
    expect(relativeName("example.com", "example.com")).toBe("@");
  });

  it("a subdomain gets ONE CNAME to the recommended target", () => {
    const r = dnsRecordsFor("edge-test.ogiam.com", { domain: "edge-test.ogiam.com", verified: true, verification: [], createdAt: 0, apexName: "ogiam.com" }, { misconfigured: true, configuredBy: null, recommendedCname: "d1e2.vercel-dns-017.com", recommendedIpv4: null });
    expect(r).toEqual([{ type: "CNAME", name: "edge-test", value: "d1e2.vercel-dns-017.com", purpose: "route" }]);
  });

  it("an apex gets an A record (an apex cannot carry a CNAME)", () => {
    const r = dnsRecordsFor("client.example", { domain: "client.example", verified: true, verification: [], createdAt: 0, apexName: "client.example" }, { misconfigured: true, configuredBy: null, recommendedCname: null, recommendedIpv4: "216.198.79.1" });
    expect(r).toEqual([{ type: "A", name: "@", value: "216.198.79.1", purpose: "route" }]);
  });

  it("falls back to the documented values with no recommendation, and adds ownership TXT records", () => {
    const r = dnsRecordsFor(
      "www.client.example",
      { domain: "www.client.example", verified: false, verification: [{ type: "TXT", domain: "_vercel.client.example", value: "vc-domain-verify=www.client.example,abc" }], createdAt: 0 },
      null,
    );
    expect(r).toEqual([
      { type: "CNAME", name: "www", value: FALLBACK_CNAME_TARGET, purpose: "route" },
      { type: "TXT", name: "_vercel", value: "vc-domain-verify=www.client.example,abc", purpose: "verify" },
    ]);
    expect(dnsRecordsFor("client.example", null, null)[0]).toEqual({ type: "A", name: "@", value: FALLBACK_APEX_IPV4, purpose: "route" });
  });
});

describe("edgeVercelConfig", () => {
  it("null unless the token, team and Edge project are all set", () => {
    expect(edgeVercelConfig({})).toBeNull();
    expect(edgeVercelConfig({ ...ENV, FORCEFIELD_EDGE_VERCEL_PROJECT_ID: "" })).toBeNull();
    expect(edgeVercelConfig(ENV)).toEqual({ token: "tok_secret_value", teamId: "team_abc", projectId: "prj_edge" });
  });
});

describe("provisionEdgeHostname", () => {
  const q = jest.fn(async () => [{ hostname: "edge-test.ogiam.com" }]) as never;

  it("not_configured: no REST call, no DB write", async () => {
    const f = jest.fn();
    const r = await provisionEdgeHostname("t1", "edge-test.ogiam.com", { env: {}, fetchImpl: f, q });
    expect(r).toEqual({ ok: false, error: "not_configured", status: 0 });
    expect(f).not.toHaveBeenCalled();
  });

  it("adds the hostname to the Edge project and reports the CNAME + pending state, cached for the admin view", async () => {
    const f = api({
      "POST /v10/projects/prj_edge/domains": () => res(200, { name: "edge-test.ogiam.com", apexName: "ogiam.com", verified: true }),
      "GET /v6/domains/edge-test.ogiam.com/config": () => res(200, CONFIG_OK),
    });
    const dbq = jest.fn(async () => [{ hostname: "edge-test.ogiam.com" }]);
    const r = await provisionEdgeHostname("t1", "edge-test.ogiam.com", { env: ENV, fetchImpl: f, q: dbq as never });
    expect(r).toEqual({
      ok: true,
      hostname: "edge-test.ogiam.com",
      attached: true,
      live: false,
      configuredBy: null,
      records: [{ type: "CNAME", name: "edge-test", value: "d1e2.vercel-dns-017.com", purpose: "route" }],
    });
    // Team-scoped: every call carries teamId; the add body names only the domain.
    for (const [url] of f.mock.calls) expect(String(url)).toContain("teamId=team_abc");
    expect(JSON.parse(String(f.mock.calls[0][1]?.body))).toEqual({ name: "edge-test.ogiam.com" });
    expect(dbq).toHaveBeenCalledWith(expect.stringContaining("UPDATE forcefield_edge_hostnames"), ["edge-test.ogiam.com", "t1", false, expect.any(String)]);
    expect(JSON.stringify(r)).not.toContain("tok_secret_value");
  });

  it("live once DNS points at the project", async () => {
    const f = api({
      "POST /v10/projects/prj_edge/domains": () => res(200, { name: "edge-test.ogiam.com", apexName: "ogiam.com", verified: true }),
      "GET /v6/domains/edge-test.ogiam.com/config": () => res(200, { ...CONFIG_OK, misconfigured: false, configuredBy: "CNAME" }),
    });
    const r = await provisionEdgeHostname("t1", "edge-test.ogiam.com", { env: ENV, fetchImpl: f, q });
    expect(r).toMatchObject({ ok: true, live: true, configuredBy: "CNAME" });
  });

  it("idempotent: already on this project (409) -> re-read, not an error", async () => {
    const f = api({
      "POST /v10/projects/prj_edge/domains": () => res(409, { error: { code: "domain_already_in_use" } }),
      "GET /v9/projects/prj_edge/domains/edge-test.ogiam.com": () => res(200, { name: "edge-test.ogiam.com", apexName: "ogiam.com", verified: true }),
      "GET /v6/domains/edge-test.ogiam.com/config": () => res(200, CONFIG_OK),
    });
    const r = await provisionEdgeHostname("t1", "edge-test.ogiam.com", { env: ENV, fetchImpl: f, q });
    expect(r).toMatchObject({ ok: true, attached: true });
  });

  it("in use by another project / account -> typed domain_in_use", async () => {
    const f = api({
      "POST /v10/projects/prj_edge/domains": () => res(409, { error: { code: "domain_already_in_use" } }),
      "GET /v9/projects/prj_edge/domains/": () => res(404, {}),
    });
    const r = await provisionEdgeHostname("t1", "edge-test.ogiam.com", { env: ENV, fetchImpl: f, q });
    expect(r).toEqual({ ok: false, error: "domain_in_use", status: 409 });
  });

  it("403 / 429 / network -> typed errors, never a throw, never the token", async () => {
    for (const [status, code] of [[403, "unauthorized"], [429, "rate_limited"]] as const) {
      const f = api({ "POST /v10/projects/prj_edge/domains": () => res(status, { error: { message: "nope" } }) });
      const r = await provisionEdgeHostname("t1", "edge-test.ogiam.com", { env: ENV, fetchImpl: f, q });
      expect(r).toEqual({ ok: false, error: code, status });
      expect(JSON.stringify(r)).not.toContain("tok_secret_value");
    }
    const down = jest.fn(async () => {
      throw new Error("ECONNRESET");
    });
    expect(await provisionEdgeHostname("t1", "edge-test.ogiam.com", { env: ENV, fetchImpl: down, q })).toEqual({ ok: false, error: "network", status: 0 });
  });

  it("a failed config read still reports the record (fallback) with live=false", async () => {
    const f = api({
      "POST /v10/projects/prj_edge/domains": () => res(200, { name: "edge-test.ogiam.com", apexName: "ogiam.com", verified: true }),
      "GET /v6/domains/edge-test.ogiam.com/config": () => res(500, {}),
    });
    const r = await provisionEdgeHostname("t1", "edge-test.ogiam.com", { env: ENV, fetchImpl: f, q });
    expect(r).toMatchObject({ ok: true, live: false, records: [{ type: "CNAME", name: "edge-test", value: FALLBACK_CNAME_TARGET }] });
  });
});

describe("checkEdgeHostname", () => {
  it("reads the current state; a hostname no longer on the project is not attached", async () => {
    const q = jest.fn(async () => []) as never;
    const f = api({
      "GET /v9/projects/prj_edge/domains/": () => res(404, {}),
      "GET /v6/domains/": () => res(200, CONFIG_OK),
    });
    const r = await checkEdgeHostname("t1", "edge-test.ogiam.com", { env: ENV, fetchImpl: f, q });
    expect(r).toMatchObject({ ok: true, attached: false, live: false });
  });
});

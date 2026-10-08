/** @jest-environment node */
/**
 * Vercel integration provisioning, built to the documented OAuth + env API. The
 * network is injected, so this pins the CONTRACT (right endpoints, params, headers,
 * and the watch-first + sensitive-token guarantees) without a real Vercel call. The
 * live install handshake is verified against the registered integration, not here.
 */
import {
  isVercelIntegrationConfigured,
  exchangeVercelCode,
  setVercelProjectEnv,
  provisionVercelProject,
  type FetchLike,
} from "../vercel";

const OLD = process.env;
beforeEach(() => {
  process.env = { ...OLD, MARKETPLACE_VERCEL_CLIENT_ID: "cid", MARKETPLACE_VERCEL_CLIENT_SECRET: "csecret", FORCEFIELD_PUBLIC_BASE_URL: "https://engine.example" };
});
afterAll(() => { process.env = OLD; });

function okJson(body: unknown): ReturnType<FetchLike> {
  return Promise.resolve({ ok: true, status: 200, json: async () => body });
}

describe("configuration gate", () => {
  it("is dark unless both client id + secret are set", () => {
    expect(isVercelIntegrationConfigured()).toBe(true);
    delete process.env.MARKETPLACE_VERCEL_CLIENT_SECRET;
    expect(isVercelIntegrationConfigured()).toBe(false);
  });
});

describe("exchangeVercelCode", () => {
  it("POSTs the documented OAuth exchange and returns the token + team", async () => {
    const calls: { url: string; body: string; headers: Record<string, string> }[] = [];
    const fetchImpl: FetchLike = (url, init) => { calls.push({ url, body: init.body, headers: init.headers }); return okJson({ access_token: "tok_1", team_id: "team_9" }); };
    const res = await exchangeVercelCode("code_abc", "https://app.example/cb", fetchImpl);
    expect(res).toEqual({ accessToken: "tok_1", teamId: "team_9" });
    expect(calls[0].url).toBe("https://api.vercel.com/v2/oauth/access_token");
    expect(calls[0].headers["content-type"]).toBe("application/x-www-form-urlencoded");
    expect(calls[0].body).toContain("client_id=cid");
    expect(calls[0].body).toContain("client_secret=csecret");
    expect(calls[0].body).toContain("code=code_abc");
    expect(calls[0].body).toContain(`redirect_uri=${encodeURIComponent("https://app.example/cb")}`);
  });

  it("returns null on a failed exchange or missing token (never throws)", async () => {
    expect(await exchangeVercelCode("c", "u", () => Promise.resolve({ ok: false, status: 400, json: async () => ({}) }))).toBeNull();
    expect(await exchangeVercelCode("c", "u", () => okJson({}))).toBeNull();
    expect(await exchangeVercelCode("c", "u", () => Promise.reject(new Error("net")))).toBeNull();
  });
});

describe("setVercelProjectEnv", () => {
  it("POSTs to the v10 env endpoint with upsert, bearer auth, and target=all", async () => {
    const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetchImpl: FetchLike = (url, init) => { calls.push({ url, headers: init.headers, body: init.body }); return okJson({}); };
    await setVercelProjectEnv("tok_1", "prj_1", "team_9", { key: "FORCEFIELD_WEB", value: "on" }, fetchImpl);
    expect(calls[0].url).toBe("https://api.vercel.com/v10/projects/prj_1/env?upsert=true&teamId=team_9");
    expect(calls[0].headers.authorization).toBe("Bearer tok_1");
    const sent = JSON.parse(calls[0].body);
    expect(sent.key).toBe("FORCEFIELD_WEB");
    expect(sent.target).toEqual(["production", "preview", "development"]);
  });

  it("writes the site key as a SENSITIVE var (not plaintext)", async () => {
    let sent: { type?: string } = {};
    const fetchImpl: FetchLike = (_u, init) => { sent = JSON.parse(init.body); return okJson({}); };
    await setVercelProjectEnv("tok", "prj", undefined, { key: "FORCEFIELD_EDGE_TOKEN", value: "ff_secret", sensitive: true }, fetchImpl);
    expect(sent.type).toBe("sensitive");
  });
});

describe("provisionVercelProject (the full one-click)", () => {
  const query = jest.fn(async (sql: string) => (sql.includes("INSERT") ? [{ id: "t1", name: "Acme", site_label: "acme", status: "active", created_at: "2026-10-08T00:00:00Z", platform: "vercel" }] : [])) as unknown as import("../../tenants").TenantQuery;

  it("exchanges, mints a vercel-platform tenant, and writes watch-first config with the token sensitive", async () => {
    const envWrites: Record<string, { value: string; type: string }> = {};
    const fetchImpl: FetchLike = (url, init) => {
      if (url.includes("/oauth/access_token")) return okJson({ access_token: "tok_1", team_id: "team_9" });
      const b = JSON.parse(init.body); envWrites[b.key] = { value: b.value, type: b.type };
      return okJson({});
    };
    const res = await provisionVercelProject(
      { code: "c", redirectUri: "https://app/cb", projectId: "prj_1", clientName: "Acme", siteLabel: "acme" },
      { fetchImpl, query },
    );
    expect(res.ok).toBe(true);
    expect(res.tenantId).toBe("t1");
    // watch-first + correct engine endpoint + sensitive token
    expect(envWrites.FORCEFIELD_WEB.value).toBe("on");
    expect(envWrites.FORCEFIELD_ENFORCE.value).toBe("off");
    expect(envWrites.FORCEFIELD_INGEST_URL.value).toBe("https://engine.example/api/forcefield/observe");
    expect(envWrites.FORCEFIELD_EDGE_TOKEN.type).toBe("sensitive");
  });

  it("stops with a typed reason at each failure (unconfigured / exchange / env)", async () => {
    // unconfigured
    delete process.env.MARKETPLACE_VERCEL_CLIENT_ID;
    expect((await provisionVercelProject({ code: "c", redirectUri: "u", projectId: "p", clientName: "n", siteLabel: "s" }, { fetchImpl: () => okJson({}), query })).reason).toBe("unconfigured");
    process.env.MARKETPLACE_VERCEL_CLIENT_ID = "cid";
    // exchange failed
    expect((await provisionVercelProject({ code: "c", redirectUri: "u", projectId: "p", clientName: "n", siteLabel: "s" }, { fetchImpl: () => Promise.resolve({ ok: false, status: 400, json: async () => ({}) }), query })).reason).toBe("exchange_failed");
    // env write failed (exchange ok + tenant minted, first env POST fails)
    const failEnv: FetchLike = (url) => url.includes("oauth") ? okJson({ access_token: "t" }) : Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
    expect((await provisionVercelProject({ code: "c", redirectUri: "u", projectId: "p", clientName: "Acme", siteLabel: "acme" }, { fetchImpl: failEnv, query })).reason).toBe("env_failed");
  });
});

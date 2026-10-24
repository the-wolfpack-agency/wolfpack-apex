/** @jest-environment node */
/**
 * The edge shim carries NO classification - it just forwards raw signals and
 * applies the central decision, and it must FAIL OPEN. That is what lets one
 * apex deploy update every site at once.
 */
import { signalsFromRequest, forcefieldDecide, forcefieldCheck, resolveAuthenticated } from "../shim";

function req(url: string, headers: Record<string, string> = {}, method = "GET"): Request {
  return new Request(url, { method, headers });
}

describe("signalsFromRequest", () => {
  it("extracts the raw signals the central engine needs", () => {
    const s = signalsFromRequest(
      req("https://ogiam.com/pricing?ref=x", { "user-agent": "curl/8", "x-vercel-ip-country": "PL", "x-forwarded-for": "1.2.3.4, 5.6.7.8", accept: "text/html" }),
    );
    expect(s.path).toBe("/pricing");
    expect(s.rawUrl).toBe("/pricing?ref=x");
    expect(s.userAgent).toBe("curl/8");
    expect(s.country).toBe("PL");
    expect(s.ip).toBe("1.2.3.4"); // first XFF hop, trimmed
    expect(s.headerNames).toEqual(expect.arrayContaining(["user-agent", "accept"]));
  });
});

describe("forcefieldDecide", () => {
  const cfg = { endpoint: "https://apex/api/forcefield/observe", token: "t", site: "ogiam.com" };
  const sig = signalsFromRequest(req("https://ogiam.com/x", { "user-agent": "sqlmap/1" }));

  it("blocks when the central engine says block", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ action: "block" }) }) as unknown as typeof fetch;
    expect(await forcefieldDecide(sig, cfg)).toBe(true);
  });
  it("allows when the engine says allow", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ action: "allow" }) }) as unknown as typeof fetch;
    expect(await forcefieldDecide(sig, cfg)).toBe(false);
  });
  it("FAILS OPEN (allow) on a network error - never breaks the site", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    expect(await forcefieldDecide(sig, cfg)).toBe(false);
  });
  it("FAILS OPEN on a non-200 from the engine", async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;
    expect(await forcefieldDecide(sig, cfg)).toBe(false);
  });
});

describe("new contract fields (platform, authenticated, asn/asOrg)", () => {
  const cfg = { endpoint: "https://apex/api/forcefield/observe", token: "t", site: "ogiam.com" };
  const sentBody = (): Record<string, unknown> => {
    const call = (global.fetch as unknown as jest.Mock).mock.calls[0];
    return JSON.parse(call[1].body as string);
  };
  const engine = (action: string) => {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => ({ action }) }) as unknown as typeof fetch;
  };

  it("passes edge-known asn/asOrg through, and drops a non-numeric asn", () => {
    const s = signalsFromRequest(req("https://ogiam.com/"), { ip: "9.9.9.9", asn: 13335, asOrg: "Cloudflare, Inc." });
    expect(s.ip).toBe("9.9.9.9"); // geo.ip wins over any header
    expect(s.asn).toBe(13335);
    expect(s.asOrg).toBe("Cloudflare, Inc.");
    const bad = signalsFromRequest(req("https://ogiam.com/"), { asn: Number.NaN });
    expect(bad.asn).toBeUndefined();
  });

  it("forwards platform, accept, secFetchDest, ip and authenticated in the engine body", async () => {
    engine("allow");
    const r = req("https://ogiam.com/wp-login.php?x=1", { accept: "text/html", "sec-fetch-dest": "document", "x-forwarded-for": "1.2.3.4" });
    await forcefieldCheck(r, { ...cfg, platform: "wordpress", isAuthenticated: () => false });
    const body = sentBody();
    expect(body).toMatchObject({
      site: "ogiam.com",
      platform: "wordpress",
      path: "/wp-login.php",
      rawUrl: "/wp-login.php?x=1",
      accept: "text/html",
      secFetchDest: "document",
      ip: "1.2.3.4",
      authenticated: false,
    });
  });

  it("NEVER blocks a site-attested signed-in request, but still reports it as authenticated", async () => {
    engine("block");
    const blocked = await forcefieldCheck(req("https://ogiam.com/x", { "user-agent": "sqlmap/1" }), { ...cfg, isAuthenticated: async () => true });
    expect(blocked).toBe(false);
    expect(sentBody().authenticated).toBe(true);
  });

  it("does not infer sign-in from a cookie or Authorization header (no hook = anonymous)", async () => {
    engine("block");
    const r = req("https://ogiam.com/x", { cookie: "session=abc", authorization: "Bearer x", "user-agent": "sqlmap/1" });
    expect(await forcefieldCheck(r, cfg)).toBe(true); // still blocked: presence proves nothing
    expect(sentBody().authenticated).toBe(false);
  });

  it("treats a throwing or non-true attestation hook as anonymous (fail-safe, never crashes)", async () => {
    const r = req("https://ogiam.com/x");
    expect(await resolveAuthenticated(r, { isAuthenticated: () => { throw new Error("db down"); } })).toBe(false);
    expect(await resolveAuthenticated(r, { isAuthenticated: () => Promise.reject(new Error("x")) })).toBe(false);
    expect(await resolveAuthenticated(r, { isAuthenticated: () => "yes" as unknown as boolean })).toBe(false);
    expect(await resolveAuthenticated(r, {})).toBe(false);
  });

  it("forcefieldCheck FAILS OPEN on a network error", async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error("boom")) as unknown as typeof fetch;
    expect(await forcefieldCheck(req("https://ogiam.com/x"), cfg)).toBe(false);
  });

  it("forcefieldDecide uses cfg.platform when the signals carry none", async () => {
    engine("allow");
    await forcefieldDecide(signalsFromRequest(req("https://ogiam.com/")), { ...cfg, platform: "wordpress" });
    expect(sentBody().platform).toBe("wordpress");
  });
});

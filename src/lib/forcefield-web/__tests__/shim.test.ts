/** @jest-environment node */
/**
 * The edge shim carries NO classification - it just forwards raw signals and
 * applies the central decision, and it must FAIL OPEN. That is what lets one
 * apex deploy update every site at once.
 */
import { signalsFromRequest, forcefieldDecide } from "../shim";

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

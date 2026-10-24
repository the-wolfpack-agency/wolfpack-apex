/** @jest-environment node */
/**
 * Contract for the CENTRAL Forcefield engine. Raw signals in -> classified +
 * recorded centrally + an enforcement decision out, so the engine lives ONCE in
 * apex and every site runs identical logic. The engine + recording are real
 * (pure/mocked I/O); the point is the endpoint composes them and fails open.
 */
const recordSiteEvent = jest.fn();
const getBlockedFingerprints = jest.fn();
const getDatacenterPrefixes = jest.fn();
const getSiteBlockEntitlement = jest.fn();
const trackEvent = jest.fn();
const resolveTenantByToken = jest.fn();
const getCrawlerRanges = jest.fn();

jest.mock("@/lib/site-analytics", () => ({ recordSiteEvent: (...a: unknown[]) => recordSiteEvent(...a) }));
jest.mock("@/lib/forcefield/blocked-fingerprints", () => ({ getBlockedFingerprints: (...a: unknown[]) => getBlockedFingerprints(...a) }));
jest.mock("@/lib/forcefield/datacenter-ranges", () => ({ getDatacenterPrefixes: (...a: unknown[]) => getDatacenterPrefixes(...a) }));
jest.mock("@/lib/forcefield/crawler-ranges", () => ({ getCrawlerRanges: (...a: unknown[]) => getCrawlerRanges(...a) }));
// Enforce-to-paid gate: mock the central license resolver; keep the pure gate real.
jest.mock("@/lib/forcefield-web/billing", () => ({
  getSiteBlockEntitlement: (...a: unknown[]) => getSiteBlockEntitlement(...a),
  entitledToBlock: (licensed: boolean | null) => licensed !== false,
}));
jest.mock("@/lib/forcefield-web/tenants", () => ({ resolveTenantByToken: (...a: unknown[]) => resolveTenantByToken(...a) }));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";
import { _resetRateWindow } from "@/lib/forcefield/rate-window";
import { parseCidr } from "@/lib/forcefield-web/hosting";

const OLD = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD, FORCEFIELD_EDGE_TOKEN: "secret-token", FORCEFIELD_DISTRIBUTE_BLOCKS: "on" };
  getBlockedFingerprints.mockResolvedValue([]);
  getDatacenterPrefixes.mockResolvedValue([]);
  recordSiteEvent.mockResolvedValue(undefined);
  getSiteBlockEntitlement.mockResolvedValue(null); // default: unmanaged site -> enforce.
  resolveTenantByToken.mockResolvedValue(null); // default: a non-secret token resolves to no tenant.
  getCrawlerRanges.mockResolvedValue({});
  _resetRateWindow();
});
afterAll(() => { process.env = OLD; });

const post = (body: unknown, token = "secret-token") =>
  new NextRequest("http://localhost/api/forcefield/observe", {
    method: "POST",
    headers: { "content-type": "application/json", "x-edge-token": token },
    body: JSON.stringify(body),
  });

const sqlmap = { site: "ogiam.com", path: "/x", method: "GET", userAgent: "sqlmap/1.7", headerNames: ["host", "user-agent"], country: "PL" };

test("401 + fail-open (allow) on a bad edge token", async () => {
  const res = await POST(post(sqlmap, "wrong"));
  expect(res.status).toBe(401);
  expect((await res.json()).action).toBe("allow");
  expect(recordSiteEvent).not.toHaveBeenCalled();
});

describe("per-tenant token auth (self-serve onboarding)", () => {
  test("accepts a valid tenant token and PINS the site to the tenant (body site ignored)", async () => {
    // enforce ON so the managed tenant actually blocks (see the enforce-gate tests below).
    resolveTenantByToken.mockResolvedValueOnce({ id: "t1", name: "Acme", siteLabel: "acme", status: "active", sharesIntel: true, enforceEnabled: true });
    // Token is NOT the shared secret; body claims a different site, which must be ignored.
    const res = await POST(post({ ...sqlmap, site: "someone-elses-site" }, "ff_tenanttoken"));
    expect(res.status).toBe(200);
    expect((await res.json()).action).toBe("block"); // sqlmap still blocks
    expect(resolveTenantByToken).toHaveBeenCalledWith("ff_tenanttoken");
    // The enforce-to-paid resolver was asked about the TENANT's site, not the body's.
    expect(getSiteBlockEntitlement).toHaveBeenCalledWith("acme");
  });

  test("a token that is neither the secret nor a known tenant -> 401 fail-open, nothing recorded", async () => {
    resolveTenantByToken.mockResolvedValueOnce(null); // unknown or disabled tenant
    const res = await POST(post(sqlmap, "ff_bogus"));
    expect(res.status).toBe(401);
    expect((await res.json()).action).toBe("allow");
    expect(recordSiteEvent).not.toHaveBeenCalled();
  });

  test("the shared secret path never does a tenant lookup", async () => {
    await POST(post(sqlmap)); // correct secret
    expect(resolveTenantByToken).not.toHaveBeenCalled();
  });
});

describe("per-tenant enforce toggle (watch-first console control)", () => {
  test("a managed tenant with enforce OFF withholds the block (watch), keeps the event", async () => {
    resolveTenantByToken.mockResolvedValueOnce({ id: "t1", name: "Acme", siteLabel: "acme", status: "active", sharesIntel: true, enforceEnabled: false });
    const res = await POST(post(sqlmap, "ff_tenanttoken"));
    const body = await res.json();
    expect(body.action).toBe("allow");   // withheld: console toggle off
    expect(body.wouldBlock).toBe(true);   // but the engine proved it hostile
    expect(recordSiteEvent).toHaveBeenCalledTimes(1); // still recorded
    expect(trackEvent).toHaveBeenCalledWith("forcefield.block_withheld_watch", "site:acme", "forcefield", expect.objectContaining({ site: "acme" }));
  });

  test("a managed tenant with enforce ON blocks", async () => {
    resolveTenantByToken.mockResolvedValueOnce({ id: "t1", name: "Acme", siteLabel: "acme", status: "active", sharesIntel: true, enforceEnabled: true });
    expect((await (await POST(post(sqlmap, "ff_tenanttoken"))).json()).action).toBe("block");
  });

  test("a first-party (shared-secret) site is unaffected by the tenant toggle - still blocks", async () => {
    expect((await (await POST(post(sqlmap))).json()).action).toBe("block");
  });
});

describe("shares_intel opt-out (does not CONSUME the shared blocklist)", () => {
  test("an opted-out tenant never fetches the distributed blocklist", async () => {
    resolveTenantByToken.mockResolvedValueOnce({ id: "t1", name: "Acme", siteLabel: "acme", status: "active", sharesIntel: false, enforceEnabled: true });
    await POST(post({ site: "acme", path: "/", method: "GET", userAgent: "Mozilla/5.0", headerNames: ["host"] }, "ff_tenanttoken"));
    expect(getBlockedFingerprints).not.toHaveBeenCalled();
  });

  test("a sharing tenant DOES fetch the distributed blocklist", async () => {
    resolveTenantByToken.mockResolvedValueOnce({ id: "t1", name: "Acme", siteLabel: "acme", status: "active", sharesIntel: true, enforceEnabled: true });
    await POST(post({ site: "acme", path: "/", method: "GET", userAgent: "Mozilla/5.0", headerNames: ["host"] }, "ff_tenanttoken"));
    expect(getBlockedFingerprints).toHaveBeenCalled();
  });
});

test("classifies + RECORDS centrally, and blocks a named attack tool", async () => {
  const res = await POST(post(sqlmap));
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.action).toBe("block");            // sqlmap -> attack_tool
  expect(body.wouldBlock).toBe(true);           // proven hostile, and entitled to enforce
  expect(body.eventType).toBe("site.agent_flagged");
  // the event was recorded centrally, WITH a stable operator fingerprint stamped
  expect(recordSiteEvent).toHaveBeenCalledTimes(1);
  const rec = recordSiteEvent.mock.calls[0][0];
  expect(rec.eventType).toBe("site.agent_flagged");
  expect(typeof rec.props.fp).toBe("string"); // <- the fingerprint ogiam's old code never emitted
});

test("a blocked operator fingerprint (set centrally) turns that operator away", async () => {
  // Compute nothing by hand: run once to learn the fp the engine stamps, then block it.
  const first = await POST(post({ ...sqlmap, userAgent: "curl/8" }));
  const fp = recordSiteEvent.mock.calls[0][0].props.fp as string;
  getBlockedFingerprints.mockResolvedValue([fp]);
  const res = await POST(post({ ...sqlmap, userAgent: "curl/8" }));
  expect((await res.json()).action).toBe("block");
  expect(first.status).toBe(200);
});

test("ENFORCE-TO-PAID: a licensed tenant's site blocks for real", async () => {
  getSiteBlockEntitlement.mockResolvedValue(true);
  const res = await POST(post(sqlmap));
  const body = await res.json();
  expect(body.action).toBe("block");
  expect(body.wouldBlock).toBe(true);
  expect(trackEvent).not.toHaveBeenCalled(); // no withhold upsell when enforcing
});

test("ENFORCE-TO-PAID: an UNLICENSED tenant watches only - block withheld, event still recorded, upsell fired", async () => {
  getSiteBlockEntitlement.mockResolvedValue(false);
  const res = await POST(post(sqlmap));
  const body = await res.json();
  expect(body.action).toBe("allow");     // free tier: never actually blocked
  expect(body.wouldBlock).toBe(true);     // but we tell them we WOULD have
  expect(body.reasonKind).toBe("attack_tool");
  expect(recordSiteEvent).toHaveBeenCalledTimes(1); // watching is always on
  expect(trackEvent).toHaveBeenCalledTimes(1);
  expect(trackEvent.mock.calls[0][0]).toBe("forcefield.block_withheld_unlicensed");
  expect(trackEvent.mock.calls[0][3]).toMatchObject({ site: "ogiam.com", reasonKind: "attack_tool" });
});

test("ENFORCE-TO-PAID: a benign request on an unlicensed site is untouched (no withhold, no upsell)", async () => {
  getSiteBlockEntitlement.mockResolvedValue(false);
  const res = await POST(post({ site: "ogiam.com", path: "/", method: "GET", userAgent: "Mozilla/5.0 (Macintosh) Chrome/120", headerNames: ["host", "user-agent", "accept", "accept-language", "sec-fetch-dest"], country: "US", secFetchDest: "document", accept: "text/html" }));
  const body = await res.json();
  expect(body.action).toBe("allow");
  expect(body.wouldBlock).toBe(false);
  expect(getSiteBlockEntitlement).not.toHaveBeenCalled(); // license only resolved when a block is pending
  expect(trackEvent).not.toHaveBeenCalled();
});

test("a normal human page view is allowed and not flagged", async () => {
  const res = await POST(post({ site: "ogiam.com", path: "/", method: "GET", userAgent: "Mozilla/5.0 (Macintosh) Chrome/120", headerNames: ["host", "user-agent", "accept", "accept-language", "sec-fetch-dest"], country: "US", secFetchDest: "document", accept: "text/html" }));
  const body = await res.json();
  expect(body.action).toBe("allow");
});


const chromeView = {
  site: "ogiam.com", path: "/", rawUrl: "/", method: "GET", country: "US", ip: "24.60.1.1",
  userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  headerNames: ["host", "user-agent", "accept", "accept-language", "accept-encoding", "sec-fetch-dest"],
  accept: "text/html", secFetchDest: "document",
};
const rec = (i = 0) => recordSiteEvent.mock.calls[i][0];

describe("400 on a body that is not a JSON object", () => {
  test.each([["not json"], ["[1,2]"], ["null"], ["\"str\""]])("%s -> 400 allow, nothing recorded", async (raw) => {
    const r = new NextRequest("http://localhost/api/forcefield/observe", { method: "POST", headers: { "content-type": "application/json", "x-edge-token": "secret-token" }, body: raw });
    const res = await POST(r);
    expect(res.status).toBe(400);
    expect((await res.json()).action).toBe("allow");
    expect(recordSiteEvent).not.toHaveBeenCalled();
  });
});

describe("decide FIRST, then record: the stored row says what happened", () => {
  test("an enforced block is recorded with blocked/action/posture/reason_kind", async () => {
    await POST(post(sqlmap));
    expect(rec().props).toMatchObject({ blocked: true, action: "block", posture: "enforce", reason_kind: "attack_tool" });
  });

  test("a block withheld by the free-tier gate is recorded as would_block + action report", async () => {
    getSiteBlockEntitlement.mockResolvedValue(false);
    await POST(post(sqlmap));
    expect(rec().props).toMatchObject({ blocked: false, would_block: true, action: "report", reason_kind: "attack_tool" });
  });

  test("a payload in rawUrl is recorded as site.agent_payload_attack with props.attack", async () => {
    const res = await POST(post({ ...chromeView, path: "/search", rawUrl: "/search?q=1%20UNION%20SELECT%20pw%20FROM%20users" }));
    const body = await res.json();
    expect(body.action).toBe("block");
    expect(body.eventType).toBe("site.agent_payload_attack");
    expect(rec().props).toMatchObject({ attack: "sql_injection", blocked: true, reason_kind: "payload" });
  });

  test("a blocked request whose observation would be null (blocked fp, static asset) is still recorded", async () => {
    const quiet = { site: "ogiam.com", path: "/sw.js", method: "GET", userAgent: "Mozilla/5.0 (X11) HeadlessChrome/131", headerNames: ["host", "user-agent", "accept", "accept-language", "accept-encoding"], country: "US" };
    // learn the fp the engine stamps for this client shape on a flagged path, then block it
    await POST(post({ ...quiet, path: "/admin" }));
    const fp = rec().props.fp as string;
    recordSiteEvent.mockClear();
    getBlockedFingerprints.mockResolvedValue([fp]);
    const res = await POST(post(quiet));
    expect((await res.json()).action).toBe("block");
    expect(recordSiteEvent).toHaveBeenCalledTimes(1);
    expect(rec()).toMatchObject({ eventType: "site.agent_flagged" });
    expect(rec().props).toMatchObject({ blocked: true, reason_kind: "blocked_fingerprint" });
  });

  test("a real Chrome page view is recorded ONLY as site.page_viewed and allowed", async () => {
    const res = await POST(post(chromeView));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ action: "allow", wouldBlock: false, eventType: "site.page_viewed" });
    expect(recordSiteEvent).toHaveBeenCalledTimes(1);
    expect(rec().eventType).toBe("site.page_viewed");
  });
});

describe("edge-supplied fields: authenticated, platform, asn, asOrg", () => {
  test("authenticated:true (boolean only) suppresses weak tells; a string 'true' does not", async () => {
    const curl = { site: "ogiam.com", path: "/api/cron", method: "POST", userAgent: "curl/8.5.0", headerNames: ["host", "user-agent"], country: "US" };
    await POST(post({ ...curl, authenticated: true }));
    expect(recordSiteEvent).not.toHaveBeenCalled();
    await POST(post({ ...curl, authenticated: "true" }));
    expect(rec().eventType).toBe("site.agent_flagged");
  });

  test("platform wordpress: /wp-login.php is the site's own page, not recon", async () => {
    await POST(post({ ...chromeView, path: "/wp-login.php", rawUrl: "/wp-login.php", platform: "wordpress" }));
    expect(recordSiteEvent.mock.calls.map((c) => c[0].eventType)).not.toContain("site.agent_probed_sensitive");
    recordSiteEvent.mockClear();
    await POST(post({ ...chromeView, path: "/wp-login.php", rawUrl: "/wp-login.php" }));
    expect(rec().eventType).toBe("site.agent_probed_sensitive");
  });

  test("a junk platform value is ignored", async () => {
    await POST(post({ ...chromeView, path: "/wp-login.php", rawUrl: "/wp-login.php", platform: "wordpress; drop table" }));
    expect(rec().eventType).toBe("site.agent_probed_sensitive");
  });

  test("asn / as_org are stamped on agent events (finite number, capped string); junk is dropped", async () => {
    await POST(post({ ...sqlmap, asn: 13335, asOrg: "x".repeat(500) }));
    expect(rec().props.asn).toBe(13335);
    expect((rec().props.as_org as string).length).toBe(80);
    recordSiteEvent.mockClear();
    await POST(post({ ...sqlmap, asn: "13335", asOrg: 7 }));
    expect(rec().props.asn).toBeUndefined();
    expect(rec().props.as_org).toBeUndefined();
  });

  test("a tenant token still pins the site even with the new fields", async () => {
    resolveTenantByToken.mockResolvedValueOnce({ id: "t1", name: "Acme", siteLabel: "acme", status: "active", sharesIntel: true, enforceEnabled: true });
    await POST(post({ ...sqlmap, site: "victim", platform: "wordpress", authenticated: true }, "ff_tenanttoken"));
    expect(rec().props.site).toBe("acme");
  });
});

describe("verified crawler identity via the composed ruleset", () => {
  const p = parseCidr("66.249.64.0/19")!;
  beforeEach(() => getCrawlerRanges.mockResolvedValue({ Googlebot: [`${p.base >>> 0}/${p.bits}`] }));
  const gb = { site: "ogiam.com", path: "/", method: "GET", userAgent: "Mozilla/5.0 (compatible; Googlebot/2.1)", headerNames: ["host", "user-agent"], country: "US" };

  test("the observe route never waits on the vendors", async () => {
    await POST(post(gb));
    expect(getCrawlerRanges).toHaveBeenCalledWith({ waitMs: 0 });
  });
  test("a real Googlebot IP is welcomed + verified", async () => {
    await POST(post({ ...gb, ip: "66.249.66.1" }));
    expect(rec()).toMatchObject({ eventType: "site.agent_welcomed" });
    expect(rec().props.agent_verification).toBe("verified");
  });
  test("a Googlebot UA from elsewhere is flagged as an impersonation", async () => {
    await POST(post({ ...gb, ip: "203.0.113.9" }));
    expect(rec()).toMatchObject({ eventType: "site.agent_flagged" });
    expect(rec().props).toMatchObject({ impersonating: "Googlebot", agent_verification: "impersonation" });
  });
  test("spoofed Googlebot + SQLi is blocked (welcome-lane hole closed)", async () => {
    const res = await POST(post({ ...gb, ip: "66.249.66.1", rawUrl: "/?id=1%20UNION%20SELECT%201" }));
    expect((await res.json()).reasonKind).toBe("payload");
  });
});

describe("live rate detection (site.agent_high_rate)", () => {
  const hits = () => recordSiteEvent.mock.calls.filter((c) => c[0].eventType === "site.agent_high_rate");
  const burst = async (body: Record<string, unknown>, n: number) => { for (let i = 0; i < n; i++) await POST(post(body)); };
  const xhr = { ...chromeView, path: "/api/items", rawUrl: "/api/items", accept: "application/json", secFetchDest: "empty" };

  test("reports ONCE when a client crosses 40 requests / 10s, report-only", async () => {
    await burst(xhr, 45);
    expect(hits()).toHaveLength(1);
    expect(hits()[0][0].props).toMatchObject({ site: "ogiam.com", rate: 40, window_s: 10, client_type: "browser" });
    expect(typeof hits()[0][0].props.sig).toBe("string");
    expect(typeof hits()[0][0].props.fp).toBe("string");
    expect(JSON.stringify(hits()[0][0])).not.toContain("24.60.1.1"); // IP never stored
  });
  test("static assets, authenticated traffic and IP-less requests are not counted", async () => {
    await burst({ ...xhr, path: "/_next/static/a.js", rawUrl: "/_next/static/a.js" }, 45);
    await burst({ ...xhr, authenticated: true }, 45);
    await burst({ ...xhr, ip: undefined }, 45);
    expect(hits()).toHaveLength(0);
  });
  test("a normal browsing pace never reports", async () => {
    await burst(xhr, 10);
    expect(hits()).toHaveLength(0);
  });
});

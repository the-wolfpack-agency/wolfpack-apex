/**
 * Contract tests for the two ingest paths that were missing:
 *
 *  1. A tenant's OWN ingest token. It used to be dead: the shared-secret check
 *     returned 401 for any other value before the tenant lookup ran, so a
 *     self-serve tenant could never ingest. Now 200, pinned to the tenant's site
 *     label (a tenant can never write another tenant's site), on its own rate
 *     bucket.
 *  2. The live rate window for vendored sites, which forward observations with
 *     no client IP: agent observations are counted per (site, sig) and one
 *     site.agent_high_rate is recorded per burst. Page views never count.
 */

export {};

const mockRecordSiteEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/site-analytics", () => ({
  ...jest.requireActual("@/lib/site-analytics"),
  recordSiteEvent: (...a: unknown[]) => mockRecordSiteEvent(...a),
}));
const mockResolveTenant = jest.fn();
jest.mock("@/lib/forcefield-web/tenants", () => ({
  resolveTenantByToken: (...a: unknown[]) => mockResolveTenant(...a),
}));
const mockRateLimit = jest.fn().mockResolvedValue({ ok: true });
jest.mock("@/lib/ogiam/gate-rate-limit", () => ({
  checkRateLimit: (...a: unknown[]) => mockRateLimit(...a),
}));

import { POST } from "@/app/api/site-analytics/ingest/route";
import { _resetRateWindow, DEFAULT_RATE } from "@/lib/forcefield/rate-window";

const ORIGINAL = { t1: process.env.SITE_ANALYTICS_INGEST_TOKEN, t2: process.env.SITE_ANALYTICS_INGEST_TOKEN_2, db: process.env.DATABASE_URL };
const TENANT = { id: "tenant-a", name: "Acme", siteLabel: "acme.com", status: "active", createdAt: "2026-10-01" };
const TENANT_TOKEN = "ff_tenant_token_value";

function mkReq(body: unknown, token?: string): any {
  const headers = new Headers({ "content-type": "application/json" });
  if (token !== undefined) headers.set("x-ingest-token", token);
  return new Request("http://test/api/site-analytics/ingest", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetRateWindow();
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "shared-secret";
  delete process.env.SITE_ANALYTICS_INGEST_TOKEN_2;
  process.env.DATABASE_URL = "postgres://registry";
  mockRateLimit.mockResolvedValue({ ok: true });
  mockResolveTenant.mockImplementation(async (t: string) => (t === TENANT_TOKEN ? TENANT : null));
});
afterAll(() => {
  for (const [k, v] of [["SITE_ANALYTICS_INGEST_TOKEN", ORIGINAL.t1], ["SITE_ANALYTICS_INGEST_TOKEN_2", ORIGINAL.t2], ["DATABASE_URL", ORIGINAL.db]] as const) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("ingest auth: shared secret and tenant token", () => {
  it("200 with the shared secret, keeps the forwarder's own site, no tenant lookup", async () => {
    const res = await POST(mkReq({ type: "site.agent_flagged", props: { site: "ogiam.com" } }, "shared-secret"));
    expect(res.status).toBe(200);
    expect(mockResolveTenant).not.toHaveBeenCalled();
    expect(mockRecordSiteEvent.mock.calls[0][0]).toMatchObject({ props: { site: "ogiam.com" }, tenantId: null });
    expect(mockRateLimit.mock.calls[0][0]).toBe("site-analytics:ingest");
  });

  it("200 with a tenant's own token, attributed to the tenant and on its own bucket", async () => {
    const res = await POST(mkReq({ type: "site.agent_flagged", path: "/x", props: { sig: "s1" } }, TENANT_TOKEN));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mockRecordSiteEvent.mock.calls[0][0]).toMatchObject({ tenantId: "tenant-a", props: { site: "acme.com", sig: "s1" } });
    expect(mockRateLimit.mock.calls[0][0]).toBe("site-analytics:ingest:tenant:tenant-a");
  });

  it("a tenant token pins the site: it cannot write another tenant's site", async () => {
    await POST(mkReq({ type: "site.page_viewed", props: { site: "victim.com" } }, TENANT_TOKEN));
    expect(mockRecordSiteEvent.mock.calls[0][0].props.site).toBe("acme.com");
  });

  it("a tenant token works even when no shared secret is configured", async () => {
    delete process.env.SITE_ANALYTICS_INGEST_TOKEN;
    expect((await POST(mkReq({ type: "site.page_viewed" }, TENANT_TOKEN))).status).toBe(200);
  });

  it("401 on a token that is neither the shared secret nor an active tenant's", async () => {
    expect((await POST(mkReq({ type: "site.page_viewed" }, "ff_unknown"))).status).toBe(401);
    expect((await POST(mkReq({ type: "site.page_viewed" }))).status).toBe(401);
    expect(mockRecordSiteEvent).not.toHaveBeenCalled();
  });

  it("401 when the tenant lookup is unavailable (fail closed)", async () => {
    mockResolveTenant.mockResolvedValue(null);
    expect((await POST(mkReq({ type: "site.page_viewed" }, TENANT_TOKEN))).status).toBe(401);
  });

  it("400 on a bad body, whichever token authenticated it", async () => {
    expect((await POST(mkReq("{nope", TENANT_TOKEN))).status).toBe(400);
    expect((await POST(mkReq({ type: "site.evil" }, TENANT_TOKEN))).status).toBe(400);
    expect((await POST(mkReq(["x"], "shared-secret"))).status).toBe(400);
    expect(mockRecordSiteEvent).not.toHaveBeenCalled();
  });

  it("503 only when there is neither a shared secret nor a tenant registry", async () => {
    delete process.env.SITE_ANALYTICS_INGEST_TOKEN;
    delete process.env.DATABASE_URL;
    expect((await POST(mkReq({ type: "site.page_viewed" }, TENANT_TOKEN))).status).toBe(503);
  });

  it("429 from the tenant's bucket is honored", async () => {
    mockRateLimit.mockResolvedValue({ ok: false });
    expect((await POST(mkReq({ type: "site.page_viewed" }, TENANT_TOKEN))).status).toBe(429);
  });
});

describe("ingest live rate for vendored sites", () => {
  const highRateCalls = () => mockRecordSiteEvent.mock.calls.map((c) => c[0]).filter((e) => e.eventType === "site.agent_high_rate");

  it("records exactly one high-rate event per burst, with the burst props", async () => {
    for (let i = 0; i < DEFAULT_RATE.threshold + 10; i++) {
      await POST(mkReq({ type: "site.agent_flagged", path: "/p", country: "US", props: { site: "vend.example", sig: "burst1", fp: "abc:curl" } }, "shared-secret"));
    }
    const bursts = highRateCalls();
    expect(bursts).toHaveLength(1);
    expect(bursts[0]).toMatchObject({
      eventType: "site.agent_high_rate",
      path: "/p",
      country: "US",
      props: { site: "vend.example", sig: "burst1", fp: "abc:curl", rate: DEFAULT_RATE.threshold, window_s: DEFAULT_RATE.windowMs / 1000, source: "ingest" },
    });
  });

  it("page views never count, even from one shared sig", async () => {
    for (let i = 0; i < DEFAULT_RATE.threshold * 2; i++) {
      await POST(mkReq({ type: "site.page_viewed", props: { site: "vend.example", sig: "shared-sig" } }, "shared-secret"));
    }
    expect(highRateCalls()).toHaveLength(0);
  });

  it("separate sigs and separate sites are separate windows", async () => {
    for (let i = 0; i < DEFAULT_RATE.threshold - 1; i++) {
      await POST(mkReq({ type: "site.agent_flagged", props: { site: "a.example", sig: "s" } }, "shared-secret"));
      await POST(mkReq({ type: "site.agent_flagged", props: { site: "b.example", sig: "s" } }, "shared-secret"));
      await POST(mkReq({ type: "site.agent_flagged", props: { site: "a.example", sig: "t" } }, "shared-secret"));
    }
    expect(highRateCalls()).toHaveLength(0);
  });

  it("a tenant's burst is keyed to and stamped with its pinned site", async () => {
    for (let i = 0; i < DEFAULT_RATE.threshold; i++) {
      await POST(mkReq({ type: "site.agent_probed_sensitive", props: { site: "spoof.example", sig: "t1" } }, TENANT_TOKEN));
    }
    const [burst] = highRateCalls();
    expect(burst).toMatchObject({ tenantId: "tenant-a", props: { site: "acme.com", sig: "t1", source: "ingest" } });
  });

  it("an incoming high-rate event is not fed back into the window, and no sig means no count", async () => {
    for (let i = 0; i < DEFAULT_RATE.threshold + 1; i++) {
      await POST(mkReq({ type: "site.agent_high_rate", props: { site: "x", sig: "loop" } }, "shared-secret"));
      await POST(mkReq({ type: "site.agent_flagged", props: { site: "x" } }, "shared-secret"));
    }
    expect(mockRecordSiteEvent.mock.calls.length).toBe((DEFAULT_RATE.threshold + 1) * 2);
  });
});

describe("attestation marks survive the props cap", () => {
  // A synthetic monitor's event carries authenticated/synthetic LAST (after the
  // attack class), so the cap would otherwise drop the mark that keeps our own
  // probes out of the Forcefield alert scan.
  const wide = (extra: Record<string, unknown>) => {
    const p: Record<string, unknown> = {};
    for (let i = 0; i < 26; i++) p[`k${i}`] = `v${i}`;
    return { ...p, ...extra };
  };

  it("keeps synthetic:true and authenticated:true beyond the cap", async () => {
    const res = await POST(mkReq({ type: "site.agent_payload_attack", path: "/", props: wide({ authenticated: true, synthetic: true }) }, "shared-secret"));
    expect(res.status).toBe(200);
    const props = mockRecordSiteEvent.mock.calls[0][0].props;
    expect(props.synthetic).toBe(true);
    expect(props.authenticated).toBe(true);
    expect(props.k23).toBe("v23");
    expect(props.k24).toBeUndefined(); // the cap itself still holds (24 keys)
  });

  it("carries only a literal boolean true (a string 'true' is not a mark)", async () => {
    await POST(mkReq({ type: "site.agent_payload_attack", path: "/", props: wide({ synthetic: "true" }) }, "shared-secret"));
    expect(mockRecordSiteEvent.mock.calls[0][0].props.synthetic).toBeUndefined();
  });

  it("a string 'true' inside the cap is not a mark either (the loop must not carry it)", async () => {
    await POST(mkReq({ type: "site.agent_payload_attack", path: "/", props: { attack: "xss", synthetic: "true", authenticated: "true" } }, "shared-secret"));
    const props = mockRecordSiteEvent.mock.calls[0][0].props;
    expect(props.synthetic).toBeUndefined();
    expect(props.authenticated).toBeUndefined();
  });
});

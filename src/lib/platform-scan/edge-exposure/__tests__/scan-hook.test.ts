/**
 * The edge-exposure hook over an existing crawl: fail-closed floor (off by
 * default, ownership), no extra requests (pure over collected responses), the
 * crawled route is never evidence, only usable responses are read, one finding
 * per product, and every outcome tracked + audited. Synthetic responses only.
 */
import { runEdgeExposureOverCrawl, type CrawledResponse } from "@/lib/platform-scan/edge-exposure/scan-hook";
import type { EdgeExposureDeps } from "@/lib/platform-scan/edge-exposure/gate";
import { EDGE_EXPOSURE_KIND } from "@/lib/platform-scan/edge-exposure/classify";

const ACTOR = { userId: "u1", role: "admin" };
const VENDOR_COOKIE: CrawledResponse = { route: "/", obs: { status: 200, headers: { "set-cookie": "DSID=abc; path=/; secure" } } };
const VENDOR_COOKIE_2: CrawledResponse = { route: "/home", obs: { status: 302, headers: { "set-cookie": "DSID=def; path=/" } } };
const PLAIN: CrawledResponse = { route: "/pricing", obs: { status: 200, headers: { "content-type": "text/html" } } };
// A site's OWN route that happens to share an appliance path: never evidence.
const ROUTE_ONLY: CrawledResponse = { route: "/dana-na/info", obs: { status: 200, headers: {} } };

function deps(over: Partial<EdgeExposureDeps> = {}): EdgeExposureDeps {
  return {
    enabled: () => true,
    curated: () => false,
    verified: jest.fn(async () => true),
    track: jest.fn(),
    audit: jest.fn(async () => ({}) as never),
    ...over,
  };
}
const run = (responses: CrawledResponse[], d: EdgeExposureDeps) =>
  runEdgeExposureOverCrawl({ workspaceId: "w1", platform: "client-x", actor: ACTOR, responses }, d);

describe("runEdgeExposureOverCrawl", () => {
  it("is OFF by default: refuses before reading any response", async () => {
    const d = deps({ enabled: () => false });
    expect(await run([VENDOR_COOKIE], d)).toEqual({ ran: false, reason: "disabled" });
    expect(d.track).toHaveBeenCalledWith("platform.edge_exposure_blocked", "u1", "admin", expect.objectContaining({ reason: "disabled" }));
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "platform.edge_exposure.blocked" }));
  });

  it("refuses an unverified client target, and a verification error fails closed", async () => {
    expect(await run([VENDOR_COOKIE], deps({ verified: jest.fn(async () => false) }))).toEqual({ ran: false, reason: "unverified_target" });
    expect(await run([VENDOR_COOKIE], deps({ verified: jest.fn(async () => { throw new Error("db down"); }) }))).toEqual({ ran: false, reason: "unverified_target" });
  });

  it("detects from a vendor response marker, one finding per product, tagged for the Exposure panel", async () => {
    const d = deps();
    const r = await run([VENDOR_COOKIE, VENDOR_COOKIE_2, PLAIN], d);
    expect(r.ran).toBe(true);
    if (!r.ran) return;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].evidence).toMatchObject({ exposure_kind: EDGE_EXPOSURE_KIND, product: "ivanti_connect_secure" });
    expect(r.findings[0].detail).toMatch(/does not protect the appliance/);
    expect(d.track).toHaveBeenCalledWith("platform.edge_exposure_detected", "u1", "admin", expect.objectContaining({ product: "ivanti_connect_secure" }));
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "platform.edge_exposure.detected" }));
  });

  it("never treats the crawled route itself as evidence", async () => {
    const r = await run([ROUTE_ONLY], deps());
    expect(r).toEqual({ ran: true, findings: [] });
  });

  it("skips error and unreachable responses", async () => {
    const r = await run(
      [
        { route: "/", obs: { status: 404, headers: { "set-cookie": "DSID=x" } } },
        { route: "/", obs: { networkError: true } },
      ],
      deps(),
    );
    expect(r).toEqual({ ran: true, findings: [] });
  });

  it("a clean run is audited as clean", async () => {
    const d = deps();
    await run([PLAIN], d);
    expect(d.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "platform.edge_exposure.clean" }));
    expect(d.track).not.toHaveBeenCalledWith("platform.edge_exposure_detected", expect.anything(), expect.anything(), expect.anything());
  });

  it("an audit failure never throws into the scan", async () => {
    const r = await run([VENDOR_COOKIE], deps({ audit: jest.fn(async () => { throw new Error("ledger"); }) }));
    expect(r.ran).toBe(true);
  });
});

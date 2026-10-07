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

jest.mock("@/lib/site-analytics", () => ({ recordSiteEvent: (...a: unknown[]) => recordSiteEvent(...a) }));
jest.mock("@/lib/forcefield/blocked-fingerprints", () => ({ getBlockedFingerprints: (...a: unknown[]) => getBlockedFingerprints(...a) }));
jest.mock("@/lib/forcefield/datacenter-ranges", () => ({ getDatacenterPrefixes: (...a: unknown[]) => getDatacenterPrefixes(...a) }));
// Enforce-to-paid gate: mock the central license resolver; keep the pure gate real.
jest.mock("@/lib/forcefield-web/billing", () => ({
  getSiteBlockEntitlement: (...a: unknown[]) => getSiteBlockEntitlement(...a),
  entitledToBlock: (licensed: boolean | null) => licensed !== false,
}));
jest.mock("@/lib/analytics", () => ({ trackEvent: (...a: unknown[]) => trackEvent(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const OLD = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD, FORCEFIELD_EDGE_TOKEN: "secret-token", FORCEFIELD_DISTRIBUTE_BLOCKS: "on" };
  getBlockedFingerprints.mockResolvedValue([]);
  getDatacenterPrefixes.mockResolvedValue([]);
  recordSiteEvent.mockResolvedValue(undefined);
  getSiteBlockEntitlement.mockResolvedValue(null); // default: unmanaged site -> enforce.
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

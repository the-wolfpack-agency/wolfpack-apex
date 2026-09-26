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

jest.mock("@/lib/site-analytics", () => ({ recordSiteEvent: (...a: unknown[]) => recordSiteEvent(...a) }));
jest.mock("@/lib/forcefield/blocked-fingerprints", () => ({ getBlockedFingerprints: (...a: unknown[]) => getBlockedFingerprints(...a) }));
jest.mock("@/lib/forcefield/datacenter-ranges", () => ({ getDatacenterPrefixes: (...a: unknown[]) => getDatacenterPrefixes(...a) }));

import { NextRequest } from "next/server";
import { POST } from "../route";

const OLD = process.env;
beforeEach(() => {
  jest.clearAllMocks();
  process.env = { ...OLD, FORCEFIELD_EDGE_TOKEN: "secret-token", FORCEFIELD_DISTRIBUTE_BLOCKS: "on" };
  getBlockedFingerprints.mockResolvedValue([]);
  getDatacenterPrefixes.mockResolvedValue([]);
  recordSiteEvent.mockResolvedValue(undefined);
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

test("a normal human page view is allowed and not flagged", async () => {
  const res = await POST(post({ site: "ogiam.com", path: "/", method: "GET", userAgent: "Mozilla/5.0 (Macintosh) Chrome/120", headerNames: ["host", "user-agent", "accept", "accept-language", "sec-fetch-dest"], country: "US", secFetchDest: "document", accept: "text/html" }));
  const body = await res.json();
  expect(body.action).toBe("allow");
});

/**
 * Our own synthetic probes never write an automatic block (and so never a block
 * decision); a real trap trip with a fingerprint still asks for one.
 */
export {};

const mockRecordSiteEvent = jest.fn().mockResolvedValue(undefined);
const mockAutoBlock = jest.fn(async () => 0);
jest.mock("@/lib/site-analytics", () => ({
  ...jest.requireActual("@/lib/site-analytics"),
  recordSiteEvent: (...a: unknown[]) => mockRecordSiteEvent(...a),
}));
jest.mock("@/lib/forcefield/blocked-fingerprints", () => ({ autoBlockFingerprint: (...a: unknown[]) => mockAutoBlock(...(a as [])) }));

import { POST } from "@/app/api/site-analytics/ingest/route";

const ORIGINAL = process.env.SITE_ANALYTICS_INGEST_TOKEN;
const mkReq = (props: Record<string, unknown>) =>
  new Request("http://test/api/site-analytics/ingest", {
    method: "POST",
    headers: { "content-type": "application/json", "x-ingest-token": "secret-token" },
    body: JSON.stringify({ type: "site.agent_trap_tripped", path: "/_ff/records", props }),
  }) as never;

beforeEach(() => {
  jest.clearAllMocks();
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret-token";
});
afterAll(() => {
  if (ORIGINAL === undefined) delete process.env.SITE_ANALYTICS_INGEST_TOKEN;
  else process.env.SITE_ANALYTICS_INGEST_TOKEN = ORIGINAL;
});

it("a real trap trip with a fingerprint asks for an automatic block", async () => {
  const res = await POST(mkReq({ fp: "aaaa1111:browser", site: "ogiam.com" }));
  expect(res.status).toBe(200);
  expect(mockAutoBlock).toHaveBeenCalledWith("aaaa1111:browser", "honeytoken");
});

it("a synthetic (token-attested) probe is recorded but never auto-blocked", async () => {
  const res = await POST(mkReq({ fp: "aaaa1111:browser", site: "ogiam.com", synthetic: true }));
  expect(res.status).toBe(200);
  expect(mockRecordSiteEvent).toHaveBeenCalled();
  expect(mockAutoBlock).not.toHaveBeenCalled();
});

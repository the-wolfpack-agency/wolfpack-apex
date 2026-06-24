/**
 * Contract tests for POST /api/site-analytics/ingest. Asserts the security
 * surface (503 when no token configured, 401 bad token, 400 bad shape, 200 +
 * persistence on a valid event) so the public ingest can never be abused or
 * silently accept junk. recordSiteEvent is mocked; this proves auth + validation
 * + the recorded shape, not the DB write.
 */

export {};

const mockRecordSiteEvent = jest.fn().mockResolvedValue(undefined);
jest.mock("@/lib/site-analytics", () => ({
  ...jest.requireActual("@/lib/site-analytics"),
  recordSiteEvent: (...a: unknown[]) => mockRecordSiteEvent(...a),
}));

import { POST, _resetIngestRateLimit } from "@/app/api/site-analytics/ingest/route";

const ORIGINAL_TOKEN = process.env.SITE_ANALYTICS_INGEST_TOKEN;

function mkReq(body: unknown, token?: string): any {
  const headers = new Headers();
  headers.set("content-type", "application/json");
  if (token !== undefined) headers.set("x-ingest-token", token);
  return new Request("http://test/api/site-analytics/ingest", {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  }) as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetIngestRateLimit();
  process.env.SITE_ANALYTICS_INGEST_TOKEN = "secret-token";
});
afterAll(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.SITE_ANALYTICS_INGEST_TOKEN;
  else process.env.SITE_ANALYTICS_INGEST_TOKEN = ORIGINAL_TOKEN;
});

describe("POST /api/site-analytics/ingest", () => {
  it("503 when no ingest token is configured (never open)", async () => {
    delete process.env.SITE_ANALYTICS_INGEST_TOKEN;
    const res = await POST(mkReq({ type: "site.page_viewed" }, "anything"));
    expect(res.status).toBe(503);
    expect(mockRecordSiteEvent).not.toHaveBeenCalled();
  });

  it("401 on a missing or wrong token", async () => {
    expect((await POST(mkReq({ type: "site.page_viewed" }))).status).toBe(401);
    expect((await POST(mkReq({ type: "site.page_viewed" }, "wrong"))).status).toBe(401);
    expect(mockRecordSiteEvent).not.toHaveBeenCalled();
  });

  it("400 on an unknown event type (closed vocabulary)", async () => {
    const res = await POST(mkReq({ type: "site.evil_event" }, "secret-token"));
    expect(res.status).toBe(400);
    expect(mockRecordSiteEvent).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON", async () => {
    const res = await POST(mkReq("{not json", "secret-token"));
    expect(res.status).toBe(400);
  });

  it("200 and records an anonymous row for a valid event", async () => {
    const res = await POST(
      mkReq(
        {
          type: "site.page_viewed",
          path: "/ogiam-iam",
          country: "US",
          referrer: "google.com",
          props: { surface: "dropdown" },
        },
        "secret-token",
      ),
    );
    expect(res.status).toBe(200);
    expect(mockRecordSiteEvent).toHaveBeenCalledTimes(1);
    expect(mockRecordSiteEvent.mock.calls[0][0]).toMatchObject({
      eventType: "site.page_viewed",
      path: "/ogiam-iam",
      country: "US",
      referrerHost: "google.com",
      props: { surface: "dropdown" },
    });
  });

  it("caps oversized country/path and drops non-scalar props (no oversized rows)", async () => {
    await POST(
      mkReq(
        {
          type: "site.cta_clicked",
          path: "/x".padEnd(500, "y"),
          country: "UNITED-STATES",
          props: { ok: "v", nested: { a: 1 } },
        },
        "secret-token",
      ),
    );
    const arg = mockRecordSiteEvent.mock.calls[0][0];
    expect(arg.path.length).toBeLessThanOrEqual(256);
    expect(arg.country.length).toBeLessThanOrEqual(4);
    expect(arg.props).toEqual({ ok: "v" }); // nested object dropped
  });
});

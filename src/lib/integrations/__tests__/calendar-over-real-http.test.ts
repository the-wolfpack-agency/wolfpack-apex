/**
 * listEvents against a real HTTP server answering in Graph's own shapes.
 *
 * The calendar analysis is the most demo-able thing we have built and the
 * only one whose input has never come from anything resembling Graph. Two
 * of its assumptions are wrong, and both of them are the kind that produce
 * a confident number rather than an error.
 */

export {};

import { createServer, type Server } from "node:http";

jest.mock("@/lib/microsoft-graph", () => {
  const actual = jest.requireActual("@/lib/microsoft-graph");
  return { ...actual, getValidToken: jest.fn(async () => ({ accessToken: "t" })) };
});

let server: Server;
let base: string;
let requests: string[] = [];
const realFetch = global.fetch;

/** One event in the shape Graph actually returns. */
function graphEvent(i: number, over: Record<string, unknown> = {}) {
  const day = 24 + (i % 5);
  const hour = 9 + (i % 8);
  return {
    id: `evt-${i}`,
    subject: `Meeting ${i}`,
    start: { dateTime: `2026-08-${day}T${String(hour).padStart(2, "0")}:00:00.0000000`, timeZone: "UTC" },
    end: { dateTime: `2026-08-${day}T${String(hour + 1).padStart(2, "0")}:00:00.0000000`, timeZone: "UTC" },
    location: { displayName: "Teams" },
    attendees: [
      { emailAddress: { name: "Dana Whitfield", address: "dana@dealer.test" }, type: "required" },
      { emailAddress: { name: "Ray Okonkwo", address: "ray@dealer.test" }, type: "required" },
    ],
    isOnlineMeeting: true,
    ...over,
  };
}

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = req.url ?? "";
    requests.push(url);
    res.setHeader("content-type", "application/json");

    /* Graph pages. A 90-day window on a busy calendar is thousands of
       events, and it hands back 200 at a time with a nextLink. */
    const page = Number(new URL(url, base).searchParams.get("page") ?? "0");
    const perPage = 200;
    const total = 450;
    const start = page * perPage;
    const value = Array.from(
      { length: Math.max(0, Math.min(perPage, total - start)) },
      (_, k) => graphEvent(start + k),
    );
    const body: Record<string, unknown> = { value };
    if (start + perPage < total) {
      body["@odata.nextLink"] = `${base}/v1.0/me/calendarview?page=${page + 1}`;
    }
    res.end(JSON.stringify(body));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  /* Every Graph URL is absolute, so the shim rewrites the host and leaves
     the path the code built untouched. What the code asks for is then a
     thing this test can read. */
  global.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === "string" ? input : input.toString();
    const rewritten = raw.replace("https://graph.microsoft.com", base);
    return realFetch(rewritten, init);
  }) as typeof fetch;
});

afterAll(async () => {
  global.fetch = realFetch;
  await new Promise<void>((r) => server.close(() => r()));
});

beforeEach(() => {
  requests = [];
});

describe("a calendar bigger than one page", () => {
  it("returns every event in the window, not the first two hundred", async () => {
    /* $top is clamped to 200 and nothing followed @odata.nextLink, so a
       90-day analysis silently read a truncated calendar and reported its
       totals as if they were the whole window. Under-counting meetings and
       over-counting free time is precisely backwards for a tool whose one
       claim is how much of the week is actually usable, and it produces a
       plausible number rather than an error. */
    const { listEvents } = await import("@/lib/integrations/microsoft-calendar");
    const events = await listEvents("u1", {
      from: "2026-08-24T00:00:00Z",
      to: "2026-11-24T00:00:00Z",
      limit: 1000,
    });
    expect(events.length).toBe(450);
  });

  it("stops at the limit it was asked for", async () => {
    const { listEvents } = await import("@/lib/integrations/microsoft-calendar");
    const events = await listEvents("u1", { limit: 50 });
    expect(events.length).toBe(50);
    /* One request, not three: a caller asking for 50 must not pull 450. */
    expect(requests.length).toBe(1);
  });

  it("cannot be made to page forever by a server that always says there is more", async () => {
    const { listEvents } = await import("@/lib/integrations/microsoft-calendar");
    await listEvents("u1", { limit: 100_000 });
    expect(requests.length).toBeLessThanOrEqual(25);
  });
});

describe("what Graph knows about an event that we were not asking for", () => {
  it("asks for the fields that decide whether something is a meeting at all", async () => {
    /* $select listed subject, start, end, location, attendees and
       isOnlineMeeting. It did not ask whether the event was cancelled,
       whether the person declined it, or whether it is a Focus Time block
       that Outlook created and nobody attends. All three were counted as
       meetings, which inflates meeting hours and destroys the usable-block
       measure that the whole analysis exists to produce. */
    const { listEvents } = await import("@/lib/integrations/microsoft-calendar");
    await listEvents("u1", { limit: 10 });
    const select = decodeURIComponent(requests[0]);
    for (const field of ["showAs", "isCancelled", "isAllDay", "responseStatus"]) {
      expect(select).toContain(field);
    }
  });

  it("carries them back so a caller can decide", async () => {
    const { listEvents } = await import("@/lib/integrations/microsoft-calendar");
    const events = await listEvents("u1", { limit: 5 });
    expect(events[0]).toMatchObject({
      showAs: expect.any(String),
      isCancelled: expect.any(Boolean),
      isAllDay: expect.any(Boolean),
    });
  });
});

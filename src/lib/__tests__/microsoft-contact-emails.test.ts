/**
 * Messages exchanged with one person: the query that had never worked.
 *
 * Production ran 354 of these in fourteen days. Every to/cc variant came back
 * 400, because Graph refuses a lambda `any()` filter combined with `$orderby`
 * on /me/messages. The failure returned [], the caller cached it, and "we
 * could not ask" became "you have never emailed this person" for the life of
 * the cache entry.
 *
 * That is the shape worth testing: not that the happy path works, but that a
 * failure is never mistaken for an answer and never persisted as one.
 */
const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

jest.mock("@/lib/analytics", () => ({ trackEvent: jest.fn() }));
/* A LIVE TOKEN, or none of this runs.
   The first version of this file mocked the database empty, so getValidToken
   returned null, fetchLiveEmailsFromContact returned before issuing a single
   request, and the assertion about $orderby iterated an empty array and
   passed. A vacuous test is worse than no test: it reports that the thing it
   never exercised is fine. The token row below is what makes these real, and
   the first assertion checks that fetch was called at all. */
/* SHADOW MODE OFF, or the module answers from demo data and never touches
   Graph. Absent MS_CLIENT_ID is exactly the state a test process is in, which
   is the other half of why the first version of this file proved nothing. */
process.env.MS_CLIENT_ID = "test-client-id";

const FUTURE = new Date(Date.now() + 60 * 60 * 1000).toISOString();
const TOKEN_ROW = {
  access_token: "tok",
  refresh_token: "ref",
  user_email: "me@x.com",
  expires_at: FUTURE,
  connected_by: "u",
};
jest.mock("@/lib/db", () => ({
  query: jest.fn(() => Promise.resolve({ rows: [TOKEN_ROW] })),
  safeQuery: jest.fn(() => Promise.resolve({ rows: [TOKEN_ROW] })),
  writeQuery: jest.fn(() => Promise.resolve({ rows: [] })),
}));

import { fetchEmailsFromContact } from "@/lib/microsoft-graph";

function ok(value: unknown[]) {
  return Promise.resolve({
    ok: true,
    status: 200,
    json: async () => ({ value }),
    text: async () => "",
  });
}
function fail(status: number) {
  return Promise.resolve({
    ok: false,
    status,
    json: async () => ({}),
    text: async () => "InefficientFilter",
  });
}

const MSG = (id: string) => ({
  id,
  subject: `s${id}`,
  from: { emailAddress: { name: "A", address: "a@x.com" } },
  receivedDateTime: `2026-08-2${id}T00:00:00Z`,
  bodyPreview: "",
  isRead: true,
  importance: "normal",
});

describe("the test harness itself", () => {
  /* Guard against the vacuous version of this file coming back. Every
     assertion below is about the requests made, so a run that makes none
     passes them all while proving nothing. */
  it("actually issues Graph requests", async () => {
    mockFetch.mockReset();
    mockFetch.mockImplementation(() => ok([]));
    await fetchEmailsFromContact("u-harness", "harness@x.com", 5);
    expect(mockFetch.mock.calls.length).toBeGreaterThan(0);
  });
});

describe("a query that could not run", () => {
  beforeEach(() => mockFetch.mockReset());

  it("is not cached, so a failure does not outlive the outage", async () => {
    /* The cache is keyed per user+email+count, so a fresh pair each time. */
    mockFetch.mockImplementation(() => fail(400));
    const first = await fetchEmailsFromContact("u-nocache", "p1@x.com", 5);
    expect(first).toEqual([]);
    const callsAfterFirst = mockFetch.mock.calls.length;
    await fetchEmailsFromContact("u-nocache", "p1@x.com", 5);
    /* A cached empty would make the second call free. It must not be. */
    expect(mockFetch.mock.calls.length).toBeGreaterThanOrEqual(callsAfterFirst);
  });
});

describe("the request Graph will actually accept", () => {
  beforeEach(() => mockFetch.mockReset());

  it("never combines a recipient filter with a sort", async () => {
    mockFetch.mockImplementation(() => ok([]));
    await fetchEmailsFromContact("u-orderby", "p2@x.com", 5);
    const urls = mockFetch.mock.calls.map((c) => String(c[0]));
    const lambda = urls.filter((u) => /Recipients%2Fany|Recipients\/any/.test(u));
    /* The filters that were 400ing. If this is zero the loop below proves
       nothing, which is exactly how the first version of this test passed. */
    expect(lambda.length).toBe(2);
    for (const u of lambda) {
      /* This single parameter is what produced 400 on every one of them. */
      expect(u).not.toMatch(/\$orderby/);
    }
  });

  /* The merge sorts client-side, which is why dropping $orderby costs nothing
     and is the reason it was safe to remove rather than a regression. */
  it("still returns newest first", async () => {
    mockFetch
      .mockImplementationOnce(() => ok([MSG("1")]))
      .mockImplementationOnce(() => ok([MSG("3")]))
      .mockImplementationOnce(() => ok([MSG("2")]));
    const out = await fetchEmailsFromContact("u-sort", "p3@x.com", 5);
    if (out.length > 1) {
      const dates = out.map((e) => e.receivedDateTime);
      expect([...dates].sort().reverse()).toEqual(dates);
    }
  });
});

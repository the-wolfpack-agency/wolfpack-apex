/**
 * livePullInbox tests — exercises the filter logic and the
 * no-token-fallback branch. Mocks listMailDelta to avoid Graph calls.
 */

jest.mock("@/lib/microsoft-graph", () => ({
  getValidToken: jest.fn(),
}));

import { livePullInbox } from "../live-pull";
import { getValidToken } from "@/lib/microsoft-graph";

const mockedToken = getValidToken as jest.MockedFunction<typeof getValidToken>;
const realFetch = global.fetch;
let lastFetchUrl = "";

function mockFetch(items: unknown[], status = 200) {
  global.fetch = jest.fn(async (url: RequestInfo | URL) => {
    lastFetchUrl = String(url);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => ({ value: items }),
      text: async () => JSON.stringify({ value: items }),
    } as Response;
  }) as typeof fetch;
}

function msg(over: Partial<{ id: string; subject: string; from: string; receivedAt: string; bodyPreview: string; hasAttachments: boolean; removed: boolean }>) {
  return {
    id: over.id ?? "x",
    subject: over.subject ?? "(none)",
    from: { emailAddress: { address: over.from ?? "x@y.z", name: null } },
    receivedDateTime: over.receivedAt ?? "2026-04-25T12:00:00Z",
    bodyPreview: over.bodyPreview ?? "preview",
    hasAttachments: over.hasAttachments ?? false,
    ...(over.removed ? { "@removed": { reason: "deleted" as const } } : {}),
  } as never;
}

describe("livePullInbox (Graph $search-backed)", () => {
  beforeEach(() => {
    mockedToken.mockReset();
    mockedToken.mockResolvedValue({ accessToken: "tok", userEmail: "u@x" });
    lastFetchUrl = "";
  });
  afterEach(() => {
    global.fetch = realFetch;
  });

  it("returns matches that pass the local subject + sender + date guards", async () => {
    mockFetch([
      msg({ id: "a", subject: "Re: PCNA Weekly Status", from: "ashley@thewolfpack.agency", receivedAt: "2026-04-21T18:54:00Z" }),
      msg({ id: "b", subject: "Lunch?", from: "ashley@thewolfpack.agency", receivedAt: "2026-04-22T12:00:00Z" }),
      msg({ id: "c", subject: "Re: PCNA Weekly Status", from: "external@elsewhere.com", receivedAt: "2026-04-22T12:00:00Z" }),
      msg({ id: "d", subject: "PCNA stuff", from: "nick@thewolfpack.agency", receivedAt: "2026-01-01T12:00:00Z" }),
    ]);

    const r = await livePullInbox({
      userId: "homyk@thewolfpack.agency",
      filters: {
        subject_match: ["PCNA"],
        sender_match: ["@thewolfpack.agency"],
        since: "2026-04-01T00:00:00Z",
      },
    });

    expect(r.skipped).toBe(false);
    expect(r.inbox_seen).toBe(4);
    expect(r.matched.map((m) => m.source_message_id).sort()).toEqual(["a"]);
    /* Confirm we asked Graph to do the heavy lifting via $search. */
    expect(lastFetchUrl).toContain("%24search");
  });

  it("returns skipped:no_user_connected when getValidToken returns null", async () => {
    mockedToken.mockResolvedValueOnce(null);
    const r = await livePullInbox({
      userId: "nobody@example",
      filters: { subject_match: [], sender_match: [] },
    });
    expect(r.skipped).toBe(true);
    expect(r.skipped_reason).toBe("no_user_connected");
  });

  it("respects the limit and reports truncated", async () => {
    const items = Array.from({ length: 12 }, (_, i) =>
      msg({ id: `m${i}`, subject: "PCNA", from: "ashley@thewolfpack.agency" }),
    );
    mockFetch(items);
    const r = await livePullInbox({
      userId: "homyk@thewolfpack.agency",
      filters: { subject_match: ["PCNA"], sender_match: [], limit: 10 },
    });
    expect(r.matched.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it("skips @removed tombstones", async () => {
    mockFetch([
      msg({ id: "live", subject: "PCNA", from: "ashley@thewolfpack.agency" }),
      msg({ id: "dead", subject: "PCNA", from: "ashley@thewolfpack.agency", removed: true }),
    ]);
    const r = await livePullInbox({
      userId: "homyk@thewolfpack.agency",
      filters: { subject_match: ["PCNA"], sender_match: [] },
    });
    expect(r.matched.length).toBe(1);
    expect(r.matched[0].source_message_id).toBe("live");
  });

  it("falls back to recent-by-date when no filters typed", async () => {
    mockFetch([msg({ id: "a", from: "ashley@thewolfpack.agency" })]);
    await livePullInbox({
      userId: "homyk@thewolfpack.agency",
      filters: { subject_match: [], sender_match: [] },
    });
    expect(lastFetchUrl).not.toContain("%24search");
    expect(lastFetchUrl).toContain("%24orderby");
  });
});

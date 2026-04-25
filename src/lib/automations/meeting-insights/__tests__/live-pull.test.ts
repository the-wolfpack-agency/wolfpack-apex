/**
 * livePullInbox tests — exercises the filter logic and the
 * no-token-fallback branch. Mocks listMailDelta to avoid Graph calls.
 */

jest.mock("@/lib/ms-graph/client", () => {
  class GraphClientError extends Error {
    constructor(public code: string, msg: string) {
      super(msg);
    }
  }
  return {
    listMailDelta: jest.fn(),
    GraphClientError,
  };
});

import { livePullInbox } from "../live-pull";
import { listMailDelta } from "@/lib/ms-graph/client";

const mockedList = listMailDelta as jest.MockedFunction<typeof listMailDelta>;

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

describe("livePullInbox", () => {
  beforeEach(() => mockedList.mockReset());

  it("returns matches that pass subject + sender + date filters", async () => {
    mockedList.mockResolvedValueOnce({
      items: [
        msg({ id: "a", subject: "Re: PCNA Weekly Status", from: "ashley@thewolfpack.agency", receivedAt: "2026-04-21T18:54:00Z" }),
        msg({ id: "b", subject: "Lunch?", from: "ashley@thewolfpack.agency", receivedAt: "2026-04-22T12:00:00Z" }),
        msg({ id: "c", subject: "Re: PCNA Weekly Status", from: "external@elsewhere.com", receivedAt: "2026-04-22T12:00:00Z" }),
        msg({ id: "d", subject: "PCNA stuff", from: "nick@thewolfpack.agency", receivedAt: "2026-01-01T12:00:00Z" }),
      ],
      nextDeltaLink: undefined,
    });

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
    /* a passes (subject+sender+date), b fails subject, c fails sender,
       d fails date. */
    expect(r.matched.map((m) => m.source_message_id).sort()).toEqual(["a"]);
  });

  it("returns skipped:no_user_connected when Graph signals no_token", async () => {
    const err = new Error("no token") as Error & { code: string };
    err.code = "no_token";
    mockedList.mockRejectedValueOnce(err);

    const r = await livePullInbox({
      userId: "nobody@example",
      filters: { subject_match: [], sender_match: [] },
    });

    expect(r.skipped).toBe(true);
    expect(r.skipped_reason).toBe("no_user_connected");
    expect(r.matched).toEqual([]);
  });

  it("respects the limit and reports truncated", async () => {
    const items = Array.from({ length: 75 }, (_, i) =>
      msg({ id: `m${i}`, subject: "PCNA", from: "ashley@thewolfpack.agency" }),
    );
    mockedList.mockResolvedValueOnce({ items, nextDeltaLink: undefined });

    const r = await livePullInbox({
      userId: "homyk@thewolfpack.agency",
      filters: { subject_match: ["PCNA"], sender_match: [], limit: 10 },
    });

    expect(r.matched.length).toBe(10);
    expect(r.truncated).toBe(true);
  });

  it("skips @removed tombstones", async () => {
    mockedList.mockResolvedValueOnce({
      items: [
        msg({ id: "live", subject: "PCNA", from: "ashley@thewolfpack.agency" }),
        msg({ id: "dead", subject: "PCNA", from: "ashley@thewolfpack.agency", removed: true }),
      ],
      nextDeltaLink: undefined,
    });

    const r = await livePullInbox({
      userId: "homyk@thewolfpack.agency",
      filters: { subject_match: ["PCNA"], sender_match: [] },
    });

    expect(r.matched.length).toBe(1);
    expect(r.matched[0].source_message_id).toBe("live");
  });
});

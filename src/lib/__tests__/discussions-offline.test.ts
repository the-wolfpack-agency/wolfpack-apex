/**
 * @jest-environment jsdom
 *
 * discussions-offline — wraps the two mutation paths on /discussions
 * (new thread + reply) so that going offline queues the mutation for
 * replay instead of silently failing. Exercises:
 *
 *   1. Online thread create: POST fires, status=sent, server-assigned id
 *   2. Offline thread create: enqueues with resource header, fires
 *      discussion.thread_queued_offline analytics
 *   3. Online reply: POST fires to /api/discussions/{id}
 *   4. Offline reply: enqueues with thread id in endpoint + analytics
 *   5. Online + non-ok (503) → falls through to queue, not dropped
 *   6. Online + thrown error (network drop) → falls through to queue
 *   7. Flush-on-online: queued mutations drain FIFO
 *   8. notifyQueueChanged fires so the pill updates
 *   9. Missing thread_id on reply throws
 */

import "fake-indexeddb/auto";
import {
  sendDiscussionThreadOffline,
  sendDiscussionReplyOffline,
  DISCUSSION_THREADS_ENDPOINT,
  DISCUSSION_THREAD_RESOURCE,
  DISCUSSION_REPLY_RESOURCE,
  discussionReplyEndpoint,
} from "@/lib/discussions-offline";
import {
  clearQueue,
  flushQueue,
  listQueue,
  __resetForTests as resetQueue,
} from "@/lib/offline-queue";

function mkResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

beforeEach(async () => {
  resetQueue();
  await clearQueue();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
  setOnline(true);
});

afterEach(async () => {
  await clearQueue();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// New thread
// ---------------------------------------------------------------------------

describe("discussions-offline — new thread (online)", () => {
  it("POSTs inline to /api/discussions and returns the server thread id", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(
      mkResponse(201, { thread: { id: "t-abc" } }),
    );
    const analytics = jest.fn();

    const res = await sendDiscussionThreadOffline(
      { title: "Offline matters", category: "engineering", content: "hi" },
      { fetchImpl: fetchSpy as unknown as typeof fetch, onAnalytics: analytics },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(DISCUSSION_THREADS_ENDPOINT);
    expect(res.status).toBe("sent");
    expect(res.id).toBe("t-abc");
    expect(await listQueue()).toHaveLength(0);
    expect(
      analytics.mock.calls.find(
        ([e]) => e === "discussion.thread_queued_offline",
      ),
    ).toBeUndefined();
  });

  it("uses a local nonce when the server response omits thread.id", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(201, {}));
    const res = await sendDiscussionThreadOffline(
      { title: "t", category: "general", content: "c" },
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(res.status).toBe("sent");
    expect(res.id).toEqual(expect.any(String));
    expect(res.id.length).toBeGreaterThan(0);
  });
});

describe("discussions-offline — new thread (offline)", () => {
  it("enqueues + fires discussion.thread_queued_offline analytics", async () => {
    setOnline(false);
    const fetchSpy = jest.fn();
    const analytics = jest.fn();

    const res = await sendDiscussionThreadOffline(
      { title: "Offline ok", category: "product", content: "content body" },
      { fetchImpl: fetchSpy as unknown as typeof fetch, onAnalytics: analytics },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe("queued");

    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(DISCUSSION_THREADS_ENDPOINT);
    expect(rows[0].method).toBe("POST");
    expect(rows[0].headers["x-instinct-resource-type"]).toBe(
      DISCUSSION_THREAD_RESOURCE,
    );
    // Authorization is stripped — replay re-attaches the fresh token.
    expect(
      Object.keys(rows[0].headers).map((k) => k.toLowerCase()),
    ).not.toContain("authorization");
    expect(JSON.parse(rows[0].body!)).toEqual({
      title: "Offline ok",
      category: "product",
      content: "content body",
    });

    const queued = analytics.mock.calls.find(
      ([e]) => e === "discussion.thread_queued_offline",
    );
    expect(queued).toBeDefined();
    const [, metadata] = queued!;
    expect(metadata.resource_type).toBe(DISCUSSION_THREAD_RESOURCE);
    expect(metadata.category).toBe("product");
    expect(metadata.title_length).toBe("Offline ok".length);
    expect(metadata.content_length).toBe("content body".length);
    expect(metadata.queue_id).toBe(rows[0].id);
  });
});

describe("discussions-offline — new thread transient server error", () => {
  it("falls through to the queue on a 503 instead of dropping the write", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(503, "busy"));
    const res = await sendDiscussionThreadOffline(
      { title: "t", category: "general", content: "c" },
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(res.status).toBe("queued");
    expect(await listQueue()).toHaveLength(1);
  });

  it("falls through to the queue when fetch throws", async () => {
    setOnline(true);
    const fetchSpy = jest
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));
    const res = await sendDiscussionThreadOffline(
      { title: "t", category: "general", content: "c" },
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(res.status).toBe("queued");
    expect(await listQueue()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Reply
// ---------------------------------------------------------------------------

describe("discussions-offline — reply (online)", () => {
  it("POSTs inline to /api/discussions/{id} and returns reply id", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(
      mkResponse(201, { reply: { id: "r-1" } }),
    );
    const analytics = jest.fn();

    const res = await sendDiscussionReplyOffline(
      { thread_id: "t-xyz", content: "answer" },
      { fetchImpl: fetchSpy as unknown as typeof fetch, onAnalytics: analytics },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(discussionReplyEndpoint("t-xyz"));
    expect(res.status).toBe("sent");
    expect(res.id).toBe("r-1");
    expect(await listQueue()).toHaveLength(0);
    expect(
      analytics.mock.calls.find(
        ([e]) => e === "discussion.reply_queued_offline",
      ),
    ).toBeUndefined();
  });
});

describe("discussions-offline — reply (offline)", () => {
  it("enqueues the reply with the thread id baked into the endpoint", async () => {
    setOnline(false);
    const analytics = jest.fn();
    const res = await sendDiscussionReplyOffline(
      { thread_id: "t-42", content: "queued reply" },
      { onAnalytics: analytics },
    );
    expect(res.status).toBe("queued");

    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(discussionReplyEndpoint("t-42"));
    expect(rows[0].method).toBe("POST");
    expect(rows[0].headers["x-instinct-resource-type"]).toBe(
      DISCUSSION_REPLY_RESOURCE,
    );
    expect(JSON.parse(rows[0].body!)).toEqual({ content: "queued reply" });

    const queued = analytics.mock.calls.find(
      ([e]) => e === "discussion.reply_queued_offline",
    );
    expect(queued).toBeDefined();
    const [, metadata] = queued!;
    expect(metadata.resource_type).toBe(DISCUSSION_REPLY_RESOURCE);
    expect(metadata.thread_id).toBe("t-42");
    expect(metadata.content_length).toBe("queued reply".length);
  });

  it("rejects a reply with no thread_id", async () => {
    await expect(
      sendDiscussionReplyOffline({ thread_id: "", content: "x" }),
    ).rejects.toThrow(/thread_id is required/i);
  });

  it("falls through to the queue on a 503 reply response", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(503, "busy"));
    const res = await sendDiscussionReplyOffline(
      { thread_id: "t-1", content: "retry" },
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(res.status).toBe("queued");
    expect(await listQueue()).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Flush-on-online
// ---------------------------------------------------------------------------

describe("discussions-offline — flush-on-online", () => {
  it("drains thread + reply mutations FIFO via the shared offline-queue", async () => {
    setOnline(false);
    await sendDiscussionThreadOffline({
      title: "first",
      category: "general",
      content: "c1",
    });
    await sendDiscussionReplyOffline({
      thread_id: "t-777",
      content: "second",
    });
    expect(await listQueue()).toHaveLength(2);

    setOnline(true);
    const replayFetch = jest.fn().mockResolvedValue(mkResponse(201, {}));
    const analytics = jest.fn();
    const summary = await flushQueue({
      fetchImpl: replayFetch as unknown as typeof fetch,
      sleep: async () => undefined,
      tokenProvider: () => "REPLAY-TOKEN",
      onAnalytics: analytics,
    });
    expect(summary.replayed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(await listQueue()).toHaveLength(0);

    // FIFO — thread first, then reply.
    const urls = replayFetch.mock.calls.map((c) => c[0] as string);
    expect(urls[0]).toBe(DISCUSSION_THREADS_ENDPOINT);
    expect(urls[1]).toBe(discussionReplyEndpoint("t-777"));

    // Replay refreshed Authorization header from tokenProvider.
    const firstInit = replayFetch.mock.calls[0][1] as RequestInit;
    const headers = new Headers(firstInit.headers as HeadersInit);
    expect(headers.get("Authorization")).toBe("Bearer REPLAY-TOKEN");
  });
});

// ---------------------------------------------------------------------------
// UI pill integration
// ---------------------------------------------------------------------------

describe("discussions-offline — pill event fires on queue", () => {
  it("dispatches instinct-offline-queue-changed on both queue paths", async () => {
    setOnline(false);
    const handler = jest.fn();
    window.addEventListener("instinct-offline-queue-changed", handler);
    try {
      await sendDiscussionThreadOffline({
        title: "a",
        category: "general",
        content: "b",
      });
      await sendDiscussionReplyOffline({
        thread_id: "t-9",
        content: "r",
      });
      expect(handler).toHaveBeenCalledTimes(2);
    } finally {
      window.removeEventListener("instinct-offline-queue-changed", handler);
    }
  });
});

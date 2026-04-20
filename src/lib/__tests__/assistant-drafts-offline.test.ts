/**
 * @jest-environment jsdom
 *
 * assistant-drafts-offline — wraps the outgoing USER MESSAGE POST to
 * /api/assistant so that, when the user hits send while offline (or the
 * server 5xx's mid-flight), the user's message is queued for replay
 * instead of being dropped. On reconnect the generic offline-queue
 * drains it FIFO. We verify:
 *
 *   1. Online happy path: POST fires, status="sent", server id used
 *   2. Offline path: no fetch, queue entry created with resource header,
 *      analytics event fires with the right shape
 *   3. Online + non-ok (503): falls through to queue, not dropped
 *   4. Online + thrown error (network drop): falls through to queue
 *   5. Flush-on-online: returning online drains the queued entry through
 *      the generic offline-queue primitive
 *   6. notifyQueueChanged fires on queue so the OfflineStatusPill updates
 */

import "fake-indexeddb/auto";
import {
  sendAssistantMessageOffline,
  ASSISTANT_ENDPOINT,
  ASSISTANT_MESSAGE_RESOURCE,
} from "@/lib/assistant-drafts-offline";
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

describe("assistant-drafts-offline — online happy path", () => {
  it("POSTs inline, returns status=sent with server messageId + response payload", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(
      mkResponse(200, {
        response: "hi back",
        source: "ai",
        tokensUsed: 42,
        conversationId: "c-1",
        messageId: "m-123",
      }),
    );
    const analytics = jest.fn();

    const res = await sendAssistantMessageOffline(
      { message: "hello", conversationId: "c-1" },
      { fetchImpl: fetchSpy as unknown as typeof fetch, onAnalytics: analytics },
    );

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(ASSISTANT_ENDPOINT);
    expect(res.status).toBe("sent");
    expect(res.id).toBe("m-123");
    expect(res.response).toBeDefined();
    expect(res.response!.answer).toBe("hi back");
    expect(res.response!.source).toBe("ai");
    expect(res.response!.tokensUsed).toBe(42);
    expect(res.response!.conversationId).toBe("c-1");
    expect(res.response!.messageId).toBe("m-123");

    const rows = await listQueue();
    expect(rows).toHaveLength(0);
    // No queued-offline analytics should fire on the inline success path.
    expect(
      analytics.mock.calls.find(
        ([e]) => e === "assistant.message_queued_offline",
      ),
    ).toBeUndefined();
  });

  it("falls back to a local nonce when the server response omits messageId", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(
      mkResponse(200, { response: "ok" }),
    );
    const res = await sendAssistantMessageOffline(
      { message: "hi" },
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(res.status).toBe("sent");
    expect(res.id).toEqual(expect.any(String));
    expect(res.id.length).toBeGreaterThan(0);
    expect(res.response!.answer).toBe("ok");
  });
});

describe("assistant-drafts-offline — offline queues the USER MESSAGE", () => {
  it("skips fetch entirely, enqueues with resource header, fires analytics", async () => {
    setOnline(false);
    const fetchSpy = jest.fn();
    const analytics = jest.fn();

    const res = await sendAssistantMessageOffline(
      {
        message: "queue me",
        conversationId: "c-9",
        pageContext: "/sites/edit",
      },
      { fetchImpl: fetchSpy as unknown as typeof fetch, onAnalytics: analytics },
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(res.status).toBe("queued");
    expect(res.id).toEqual(expect.any(String));

    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(ASSISTANT_ENDPOINT);
    expect(rows[0].method).toBe("POST");
    expect(rows[0].headers["x-instinct-resource-type"]).toBe(
      ASSISTANT_MESSAGE_RESOURCE,
    );
    // Authorization must NEVER persist into the queued headers —
    // JWTs are 15 min TTL; the queue is re-auth'd at replay time.
    expect(
      Object.keys(rows[0].headers).map((k) => k.toLowerCase()),
    ).not.toContain("authorization");
    const body = JSON.parse(rows[0].body!);
    expect(body.message).toBe("queue me");
    expect(body.conversationId).toBe("c-9");
    expect(body.pageContext).toBe("/sites/edit");

    // Per-feature analytics event
    const queued = analytics.mock.calls.find(
      ([e]) => e === "assistant.message_queued_offline",
    );
    expect(queued).toBeDefined();
    const [, metadata] = queued!;
    expect(metadata.resource_type).toBe(ASSISTANT_MESSAGE_RESOURCE);
    expect(metadata.conversation_id).toBe("c-9");
    expect(metadata.message_length).toBe("queue me".length);
    expect(metadata.has_page_context).toBe(true);
    expect(metadata.queue_id).toBe(rows[0].id);
  });

  it("rejects an empty or missing message", async () => {
    await expect(
      // @ts-expect-error — runtime validation
      sendAssistantMessageOffline({ message: "" }),
    ).rejects.toThrow(/message is required/i);
  });
});

describe("assistant-drafts-offline — online but transient server failure", () => {
  it("falls through to the queue on a 503 instead of dropping the user message", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(503, "busy"));
    const analytics = jest.fn();

    const res = await sendAssistantMessageOffline(
      { message: "retry me" },
      { fetchImpl: fetchSpy as unknown as typeof fetch, onAnalytics: analytics },
    );
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(res.status).toBe("queued");

    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(
      analytics.mock.calls.some(
        ([e]) => e === "assistant.message_queued_offline",
      ),
    ).toBe(true);
  });

  it("falls through to the queue when fetch throws (mid-flight network drop)", async () => {
    setOnline(true);
    const fetchSpy = jest
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const res = await sendAssistantMessageOffline(
      { message: "dropped" },
      { fetchImpl: fetchSpy as unknown as typeof fetch },
    );
    expect(res.status).toBe("queued");
    const rows = await listQueue();
    expect(rows).toHaveLength(1);
  });
});

describe("assistant-drafts-offline — flush-on-online replays through offline-queue", () => {
  it("drains queued assistant messages when flushQueue runs with a healthy server", async () => {
    setOnline(false);
    await sendAssistantMessageOffline({ message: "q1" });
    await sendAssistantMessageOffline({ message: "q2" });
    expect(await listQueue()).toHaveLength(2);

    setOnline(true);
    const replayFetch = jest.fn().mockResolvedValue(mkResponse(200, {}));
    const analytics = jest.fn();

    const summary = await flushQueue({
      fetchImpl: replayFetch as unknown as typeof fetch,
      sleep: async () => undefined,
      tokenProvider: () => "REPLAY-TOKEN",
      onAnalytics: analytics,
    });
    expect(summary.replayed).toBe(2);
    expect(summary.failed).toBe(0);
    expect(replayFetch).toHaveBeenCalledTimes(2);
    // Queue is drained after success.
    expect(await listQueue()).toHaveLength(0);
    // Each entry should fire a replayed analytics event.
    const replayed = analytics.mock.calls.filter(
      ([e]) => e === "offline.mutation_replayed",
    );
    expect(replayed).toHaveLength(2);
  });
});

describe("assistant-drafts-offline — UI 'will send when online' pill integration", () => {
  it("dispatches instinct-offline-queue-changed when we queue, so the pill updates", async () => {
    setOnline(false);
    const handler = jest.fn();
    window.addEventListener("instinct-offline-queue-changed", handler);
    try {
      await sendAssistantMessageOffline({ message: "pill me" });
      expect(handler).toHaveBeenCalled();
    } finally {
      window.removeEventListener("instinct-offline-queue-changed", handler);
    }
  });
});

/**
 * @jest-environment jsdom
 *
 * knowledge-capture-offline round-trip: offline capture enqueues +
 * caches, online capture hits the server inline, non-ok falls through,
 * list/delete round-trip.
 */

import "fake-indexeddb/auto";
import {
  saveKnowledgeEntryOffline,
  loadKnowledgeEntry,
  listOfflineKnowledgeEntries,
  deleteOfflineKnowledgeEntry,
  KNOWLEDGE_ENTRY_ENDPOINT,
  KNOWLEDGE_ENTRY_RESOURCE,
  type KnowledgeCaptureDraft,
} from "@/lib/knowledge-capture-offline";
import {
  clearQueue,
  listQueue,
  __resetForTests as resetQueue,
} from "@/lib/offline-queue";
import {
  clearAllResources,
  __resetForTests as resetCache,
} from "@/lib/offline-cache";

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

function mkDraft(
  overrides: Partial<KnowledgeCaptureDraft> = {},
): KnowledgeCaptureDraft {
  return {
    entry_id: "k-1",
    question: "How does the JWT refresh flow work?",
    answer: "The refresh cookie is HttpOnly; fetchWithRefresh auto-rotates.",
    source: "human",
    tags: ["auth"],
    created_at: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  resetQueue();
  resetCache();
  await clearQueue();
  await clearAllResources();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
  setOnline(true);
});

afterEach(async () => {
  await clearQueue();
  await clearAllResources();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe("knowledge-capture-offline — offline capture enqueues + caches", () => {
  it("queues the POST for replay and writes to the cache", async () => {
    setOnline(false);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));

    const draft = mkDraft({ entry_id: "off-1", question: "How do we ship?" });
    const res = await saveKnowledgeEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(res.status).toBe("queued");
    expect(res.id).toBe("off-1");
    expect(res.queueId).not.toBeNull();

    // fetch never fired — we were offline.
    expect(fetchSpy).not.toHaveBeenCalled();

    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(KNOWLEDGE_ENTRY_ENDPOINT);
    expect(rows[0].method).toBe("POST");
    expect(rows[0].headers["x-instinct-resource-type"]).toBe(
      KNOWLEDGE_ENTRY_RESOURCE,
    );
    expect(JSON.parse(rows[0].body!)).toEqual(draft);

    const cached = await loadKnowledgeEntry("off-1", { silent: true });
    expect(cached).toEqual(draft);
  });

  it("rejects when entry_id is missing", async () => {
    await expect(
      // @ts-expect-error — intentional misuse for guardrail
      saveKnowledgeEntryOffline({ question: "q", answer: "a" }),
    ).rejects.toThrow(/entry_id/);
  });

  it("rejects when question is missing", async () => {
    await expect(
      // @ts-expect-error — intentional misuse for guardrail
      saveKnowledgeEntryOffline({ entry_id: "k", answer: "a", created_at: 0 }),
    ).rejects.toThrow(/question/);
  });

  it("rejects when answer is missing", async () => {
    await expect(
      // @ts-expect-error — intentional misuse for guardrail
      saveKnowledgeEntryOffline({ entry_id: "k", question: "q", created_at: 0 }),
    ).rejects.toThrow(/answer/);
  });
});

describe("knowledge-capture-offline — online save hits server inline", () => {
  it("POSTs directly on success and does NOT enqueue", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));

    const draft = mkDraft({ entry_id: "on-1" });
    const res = await saveKnowledgeEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(res.status).toBe("created");
    expect(res.queueId).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(KNOWLEDGE_ENTRY_ENDPOINT);

    const rows = await listQueue();
    expect(rows).toHaveLength(0);

    const cached = await loadKnowledgeEntry("on-1", { silent: true });
    expect(cached).toEqual(draft);
  });

  it("falls through to queue on non-ok response", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(503));

    const draft = mkDraft({ entry_id: "flaky-1" });
    const res = await saveKnowledgeEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("queued");
    expect(res.queueId).not.toBeNull();
    expect((await listQueue()).length).toBe(1);
  });

  it("falls through to queue when the fetch throws", async () => {
    setOnline(true);
    const fetchSpy = jest
      .fn()
      .mockRejectedValue(new TypeError("network down"));

    const draft = mkDraft({ entry_id: "drop-1" });
    const res = await saveKnowledgeEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("queued");
    expect((await listQueue()).length).toBe(1);
  });
});

describe("knowledge-capture-offline — list + delete", () => {
  it("lists cached entries", async () => {
    setOnline(false);
    await saveKnowledgeEntryOffline(mkDraft({ entry_id: "a" }));
    await saveKnowledgeEntryOffline(mkDraft({ entry_id: "b" }));
    const rows = await listOfflineKnowledgeEntries();
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.resource_id).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(
      rows.every((r) => r.resource_type === KNOWLEDGE_ENTRY_RESOURCE),
    ).toBe(true);
  });

  it("deleteOfflineKnowledgeEntry removes the cache entry", async () => {
    setOnline(false);
    await saveKnowledgeEntryOffline(mkDraft({ entry_id: "del-1" }));
    expect(await loadKnowledgeEntry("del-1", { silent: true })).not.toBeNull();
    await deleteOfflineKnowledgeEntry("del-1");
    expect(await loadKnowledgeEntry("del-1", { silent: true })).toBeNull();
  });
});

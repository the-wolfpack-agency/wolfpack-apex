/**
 * @jest-environment jsdom
 *
 * knowledge-capture-offline EDIT + DELETE path — mirrors the create-path
 * test. Covers: online PUT/DELETE happy paths, offline enqueue, 404
 * passthrough on delete, analytics event firing for the queued paths.
 */

import "fake-indexeddb/auto";
import {
  updateKnowledgeEntryOffline,
  deleteKnowledgeEntryOffline,
  loadKnowledgeEntry,
  saveKnowledgeEntryOffline,
  KNOWLEDGE_ENTRY_ENDPOINT,
  KNOWLEDGE_ENTRY_RESOURCE,
  type KnowledgeEditDraft,
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

function mkEditDraft(
  overrides: Partial<KnowledgeEditDraft> = {},
): KnowledgeEditDraft {
  return {
    entry_id: "k-1",
    question: "How does the JWT refresh flow work?",
    answer: "The refresh cookie is HttpOnly; fetchWithRefresh auto-rotates.",
    tags: ["auth"],
    source: "human",
    updated_at: Date.now(),
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

describe("updateKnowledgeEntryOffline — online PUT", () => {
  it("PUTs to /api/knowledge/{id} with JSON body on success", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));

    const draft = mkEditDraft({
      entry_id: "edit-1",
      question: "updated q",
      answer: "updated a",
      tags: ["updated"],
    });
    const res = await updateKnowledgeEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(res.status).toBe("created");
    expect(res.id).toBe("edit-1");
    expect(res.queueId).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${KNOWLEDGE_ENTRY_ENDPOINT}/edit-1`);
    const init = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(init.method).toBe("PUT");
    expect(JSON.parse(init.body as string)).toEqual(draft);

    // Queue stayed clean.
    expect((await listQueue()).length).toBe(0);

    // Local cache reflects the edit.
    const cached = await loadKnowledgeEntry("edit-1", { silent: true });
    expect(cached).toEqual(draft);
  });

  it("rejects when entry_id / question / answer are missing", async () => {
    await expect(
      // @ts-expect-error — intentional misuse
      updateKnowledgeEntryOffline({ question: "q", answer: "a", updated_at: 0 }),
    ).rejects.toThrow(/entry_id/);
    await expect(
      // @ts-expect-error — intentional misuse
      updateKnowledgeEntryOffline({ entry_id: "k", answer: "a", updated_at: 0 }),
    ).rejects.toThrow(/question/);
    await expect(
      // @ts-expect-error — intentional misuse
      updateKnowledgeEntryOffline({ entry_id: "k", question: "q", updated_at: 0 }),
    ).rejects.toThrow(/answer/);
  });
});

describe("updateKnowledgeEntryOffline — offline queue path", () => {
  it("enqueues PUT for replay and fires knowledge.entry_updated_offline", async () => {
    setOnline(false);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));

    // Also spy on the fire-and-forget analytics POST — the offline
    // event is posted via fetchWithRefresh → window.fetch.
    const analyticsSpy = jest.fn().mockResolvedValue(mkResponse(200));
    const originalFetch = global.fetch;
    global.fetch = analyticsSpy as unknown as typeof fetch;

    try {
      const draft = mkEditDraft({ entry_id: "edit-off-1" });
      const res = await updateKnowledgeEntryOffline(draft, {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });

      expect(res.status).toBe("queued");
      expect(res.queueId).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();

      const rows = await listQueue();
      expect(rows).toHaveLength(1);
      expect(rows[0].endpoint).toBe(`${KNOWLEDGE_ENTRY_ENDPOINT}/edit-off-1`);
      expect(rows[0].method).toBe("PUT");
      expect(rows[0].headers["x-instinct-resource-type"]).toBe(
        KNOWLEDGE_ENTRY_RESOURCE,
      );
      expect(JSON.parse(rows[0].body!)).toEqual(draft);

      // Wait one microtask so the fire-and-forget analytics call lands.
      await Promise.resolve();
      await Promise.resolve();

      const analyticsCall = analyticsSpy.mock.calls.find((c) => {
        const init = c[1] as RequestInit | undefined;
        if (!init?.body) return false;
        try {
          const parsed = JSON.parse(init.body as string);
          return parsed.event === "knowledge.entry_updated_offline";
        } catch {
          return false;
        }
      });
      expect(analyticsCall).toBeTruthy();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls through to queue on non-ok PUT response", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(503));

    const draft = mkEditDraft({ entry_id: "flaky-edit-1" });
    const res = await updateKnowledgeEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("queued");
    expect((await listQueue()).length).toBe(1);
  });

  it("falls through to queue when the PUT throws", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockRejectedValue(new TypeError("down"));

    const draft = mkEditDraft({ entry_id: "throw-edit-1" });
    const res = await updateKnowledgeEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("queued");
    expect((await listQueue()).length).toBe(1);
  });
});

describe("deleteKnowledgeEntryOffline — online, 404 passthrough, offline", () => {
  it("DELETEs on success and clears local cache", async () => {
    setOnline(true);
    await saveKnowledgeEntryOffline(
      {
        entry_id: "del-1",
        question: "q",
        answer: "a",
        source: "human",
        tags: [],
        created_at: Date.now(),
      },
      { fetchImpl: jest.fn().mockResolvedValue(mkResponse(200)) as unknown as typeof fetch },
    );
    expect(await loadKnowledgeEntry("del-1", { silent: true })).not.toBeNull();

    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));
    const res = await deleteKnowledgeEntryOffline("del-1", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(res.status).toBe("deleted");
    expect(res.id).toBe("del-1");
    expect(res.queueId).toBeNull();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(`${KNOWLEDGE_ENTRY_ENDPOINT}/del-1`);
    expect((fetchSpy.mock.calls[0][1] as RequestInit).method).toBe("DELETE");

    expect(await loadKnowledgeEntry("del-1", { silent: true })).toBeNull();
    expect((await listQueue()).length).toBe(0);
  });

  it("treats 404 as terminal success (server already agrees row is gone)", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(404));

    const res = await deleteKnowledgeEntryOffline("ghost-1", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("deleted");
    expect(res.queueId).toBeNull();
    expect((await listQueue()).length).toBe(0);
  });

  it("enqueues DELETE when offline and fires knowledge.entry_deleted_offline", async () => {
    setOnline(false);
    const fetchSpy = jest.fn();

    const analyticsSpy = jest.fn().mockResolvedValue(mkResponse(200));
    const originalFetch = global.fetch;
    global.fetch = analyticsSpy as unknown as typeof fetch;

    try {
      const res = await deleteKnowledgeEntryOffline("del-off-1", {
        fetchImpl: fetchSpy as unknown as typeof fetch,
      });
      expect(res.status).toBe("queued");
      expect(res.queueId).not.toBeNull();
      expect(fetchSpy).not.toHaveBeenCalled();

      const rows = await listQueue();
      expect(rows).toHaveLength(1);
      expect(rows[0].endpoint).toBe(`${KNOWLEDGE_ENTRY_ENDPOINT}/del-off-1`);
      expect(rows[0].method).toBe("DELETE");
      expect(rows[0].headers["x-instinct-resource-type"]).toBe(
        KNOWLEDGE_ENTRY_RESOURCE,
      );

      await Promise.resolve();
      await Promise.resolve();

      const analyticsCall = analyticsSpy.mock.calls.find((c) => {
        const init = c[1] as RequestInit | undefined;
        if (!init?.body) return false;
        try {
          const parsed = JSON.parse(init.body as string);
          return parsed.event === "knowledge.entry_deleted_offline";
        } catch {
          return false;
        }
      });
      expect(analyticsCall).toBeTruthy();
    } finally {
      global.fetch = originalFetch;
    }
  });

  it("falls through to queue on non-ok, non-404 DELETE", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(500));

    const res = await deleteKnowledgeEntryOffline("server-err-1", {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("queued");
    expect((await listQueue()).length).toBe(1);
  });

  it("rejects when entryId is missing", async () => {
    await expect(deleteKnowledgeEntryOffline("")).rejects.toThrow(/entry_id/);
  });
});

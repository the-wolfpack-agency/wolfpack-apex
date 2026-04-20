/**
 * @jest-environment jsdom
 *
 * journals-offline round-trip: offline PUT enqueues + caches, online
 * PUT hits the server inline, non-ok falls through to the queue, list
 * and delete round-trip.
 */

import "fake-indexeddb/auto";
import {
  saveJournalEntryOffline,
  loadJournalEntry,
  listOfflineJournalEntries,
  deleteOfflineJournalEntry,
  JOURNAL_ENTRY_ENDPOINT,
  JOURNAL_ENTRY_RESOURCE,
  type JournalEntryDraft,
} from "@/lib/journals-offline";
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

function mkDraft(overrides: Partial<JournalEntryDraft> = {}): JournalEntryDraft {
  return {
    journal_id: "j-1",
    content: "Notes from today",
    mood: "productive",
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

describe("journals-offline — offline save enqueues + caches", () => {
  it("queues the journal PUT for replay and writes it to the cache", async () => {
    setOnline(false);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));

    const draft = mkDraft({ journal_id: "off-1", content: "offline note" });
    const res = await saveJournalEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(res.status).toBe("queued");
    expect(res.id).toBe("off-1");
    expect(res.queueId).not.toBeNull();

    // fetchImpl never fires — we were offline.
    expect(fetchSpy).not.toHaveBeenCalled();

    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(JOURNAL_ENTRY_ENDPOINT);
    expect(rows[0].method).toBe("PUT");
    expect(rows[0].headers["x-instinct-resource-type"]).toBe(
      JOURNAL_ENTRY_RESOURCE,
    );
    expect(JSON.parse(rows[0].body!)).toEqual(draft);

    // Cache populated for offline cold-loads.
    const cached = await loadJournalEntry("off-1", { silent: true });
    expect(cached).toEqual(draft);
  });

  it("throws when journal_id is missing", async () => {
    setOnline(true);
    await expect(
      // @ts-expect-error — intentional misuse for guardrail assertion
      saveJournalEntryOffline({ content: "no id" }),
    ).rejects.toThrow(/journal_id/);
  });
});

describe("journals-offline — online save hits the server inline", () => {
  it("calls the endpoint directly on success and does NOT enqueue", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));

    const draft = mkDraft({ journal_id: "on-1" });
    const res = await saveJournalEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });

    expect(res.status).toBe("created");
    expect(res.queueId).toBeNull();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(JOURNAL_ENTRY_ENDPOINT);
    const opts = fetchSpy.mock.calls[0][1] as RequestInit;
    expect(opts.method).toBe("PUT");

    const rows = await listQueue();
    expect(rows).toHaveLength(0);

    // Cache still populated.
    const cached = await loadJournalEntry("on-1", { silent: true });
    expect(cached).toEqual(draft);
  });

  it("falls through to queue when online save returns non-ok", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(503, "busy"));

    const draft = mkDraft({ journal_id: "flaky-1" });
    const res = await saveJournalEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("queued");
    expect(res.queueId).not.toBeNull();
    expect((await listQueue()).length).toBe(1);
  });

  it("falls through to queue when the fetch throws mid-flight", async () => {
    setOnline(true);
    const fetchSpy = jest
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const draft = mkDraft({ journal_id: "drop-1" });
    const res = await saveJournalEntryOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.status).toBe("queued");
    expect(res.queueId).not.toBeNull();
    expect((await listQueue()).length).toBe(1);
  });
});

describe("journals-offline — list + delete", () => {
  it("lists cached entries for inspection, newest-first", async () => {
    setOnline(false);
    await saveJournalEntryOffline(mkDraft({ journal_id: "a" }));
    await saveJournalEntryOffline(mkDraft({ journal_id: "b" }));
    const rows = await listOfflineJournalEntries();
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.resource_id).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(rows.every((r) => r.resource_type === JOURNAL_ENTRY_RESOURCE)).toBe(
      true,
    );
  });

  it("deleteOfflineJournalEntry removes the cache entry", async () => {
    setOnline(false);
    await saveJournalEntryOffline(mkDraft({ journal_id: "del-1" }));
    expect(await loadJournalEntry("del-1", { silent: true })).not.toBeNull();
    await deleteOfflineJournalEntry("del-1");
    expect(await loadJournalEntry("del-1", { silent: true })).toBeNull();
  });
});

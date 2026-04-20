/**
 * @jest-environment jsdom
 *
 * Worked-example round-trip: the offline pattern applied to meeting
 * drafts. We exercise the full path — offline save enqueues + caches,
 * online save hits the server inline, subsequent load returns the
 * cached draft.
 */

import "fake-indexeddb/auto";
import {
  saveMeetingDraftOffline,
  loadMeetingDraft,
  listOfflineMeetingDrafts,
  deleteOfflineMeetingDraft,
  MEETING_DRAFT_ENDPOINT,
  MEETING_DRAFT_RESOURCE,
  type MeetingDraft,
} from "@/lib/meetings-offline";
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

function mkDraft(overrides: Partial<MeetingDraft> = {}): MeetingDraft {
  return {
    draft_id: "d-1",
    title: "Kickoff",
    notes: "Notes...",
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

describe("meetings-offline — offline save enqueues + caches", () => {
  it("queues the draft for replay and writes it to the cache", async () => {
    setOnline(false);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));

    const draft = mkDraft({ draft_id: "off-1", title: "Standup" });
    const res = await saveMeetingDraftOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.syncedInline).toBe(false);
    expect(res.queueId).not.toBeNull();

    // fetchImpl never fired because we were offline.
    expect(fetchSpy).not.toHaveBeenCalled();

    // Entry is in the queue.
    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe(MEETING_DRAFT_ENDPOINT);
    expect(rows[0].method).toBe("POST");
    expect(rows[0].headers["x-instinct-resource-type"]).toBe(
      MEETING_DRAFT_RESOURCE,
    );
    expect(JSON.parse(rows[0].body!)).toEqual(draft);

    // Cache is populated for offline cold-loads.
    const cached = await loadMeetingDraft("off-1", { silent: true });
    expect(cached).toEqual(draft);
  });
});

describe("meetings-offline — online save posts inline and skips the queue", () => {
  it("hits the endpoint directly on success and does NOT enqueue", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));

    const draft = mkDraft({ draft_id: "on-1" });
    const res = await saveMeetingDraftOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.syncedInline).toBe(true);
    expect(res.queueId).toBeNull();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe(MEETING_DRAFT_ENDPOINT);

    const rows = await listQueue();
    expect(rows).toHaveLength(0);

    // Cache still populated so subsequent reads are instant.
    const cached = await loadMeetingDraft("on-1", { silent: true });
    expect(cached).toEqual(draft);
  });

  it("falls through to the queue when an online save hits a non-ok response", async () => {
    setOnline(true);
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(503, "busy"));

    const draft = mkDraft({ draft_id: "flaky-1" });
    const res = await saveMeetingDraftOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.syncedInline).toBe(false);
    expect(res.queueId).not.toBeNull();

    const rows = await listQueue();
    expect(rows).toHaveLength(1);
  });

  it("falls through to the queue when an online save throws (mid-flight network drop)", async () => {
    setOnline(true);
    const fetchSpy = jest
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const draft = mkDraft({ draft_id: "drop-1" });
    const res = await saveMeetingDraftOffline(draft, {
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(res.syncedInline).toBe(false);
    expect(res.queueId).not.toBeNull();
    expect((await listQueue()).length).toBe(1);
  });
});

describe("meetings-offline — list + delete", () => {
  it("lists cached drafts for inspection", async () => {
    setOnline(false);
    await saveMeetingDraftOffline(mkDraft({ draft_id: "a", title: "A" }));
    await saveMeetingDraftOffline(mkDraft({ draft_id: "b", title: "B" }));
    const rows = await listOfflineMeetingDrafts();
    expect(rows).toHaveLength(2);
    const ids = rows.map((r) => r.resource_id).sort();
    expect(ids).toEqual(["a", "b"]);
    expect(rows.every((r) => r.resource_type === MEETING_DRAFT_RESOURCE)).toBe(
      true,
    );
  });

  it("deleteOfflineMeetingDraft removes the cache entry", async () => {
    setOnline(false);
    await saveMeetingDraftOffline(mkDraft({ draft_id: "del-1" }));
    expect(await loadMeetingDraft("del-1", { silent: true })).not.toBeNull();
    await deleteOfflineMeetingDraft("del-1");
    expect(await loadMeetingDraft("del-1", { silent: true })).toBeNull();
  });
});

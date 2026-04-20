/**
 * @jest-environment jsdom
 *
 * Generic offline-cache — write / read / delete / list + composite key
 * isolation across resource types + analytics contract
 * (offline.resource_served_from_cache fires on hit with resource_type
 * + resource_id + cache_age_ms).
 */

import "fake-indexeddb/auto";
import {
  cacheResource,
  readCachedResource,
  clearResource,
  listCachedResources,
  clearAllResources,
  getResourceAgeMs,
  composeKey,
  __resetForTests,
} from "@/lib/offline-cache";

interface FakeDraft {
  title: string;
  body: string;
}

beforeEach(async () => {
  __resetForTests();
  await clearAllResources();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
});

afterEach(async () => {
  await clearAllResources();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe("offline-cache — composite key", () => {
  it("composeKey joins type + id with :: separator", () => {
    expect(composeKey("meeting_draft", "abc")).toBe("meeting_draft::abc");
  });
});

describe("offline-cache — basic write/read", () => {
  it("returns null for an uncached resource", async () => {
    const rec = await readCachedResource("meeting_draft", "missing", {
      silent: true,
    });
    expect(rec).toBeNull();
  });

  it("persists and reads a resource with the expected shape", async () => {
    const draft: FakeDraft = { title: "Kickoff", body: "notes..." };
    await cacheResource("meeting_draft", "d-1", draft);

    const rec = await readCachedResource<FakeDraft>(
      "meeting_draft",
      "d-1",
      { silent: true },
    );
    expect(rec).not.toBeNull();
    expect(rec!.resource_type).toBe("meeting_draft");
    expect(rec!.resource_id).toBe("d-1");
    expect(rec!.data).toEqual(draft);
    expect(rec!.fetched_at).toBeGreaterThan(0);
  });

  it("overwrites existing resource on repeat put (keyPath uniqueness)", async () => {
    await cacheResource("brief", "site-1", { title: "v1" });
    await cacheResource("brief", "site-1", { title: "v2" });
    const rec = await readCachedResource<{ title: string }>(
      "brief",
      "site-1",
      { silent: true },
    );
    expect(rec!.data.title).toBe("v2");
  });
});

describe("offline-cache — composite key isolates resource types", () => {
  it("same resource_id under two types does NOT collide", async () => {
    await cacheResource("brief", "shared-id", { from: "brief" });
    await cacheResource("meeting_draft", "shared-id", { from: "draft" });

    const brief = await readCachedResource<{ from: string }>(
      "brief",
      "shared-id",
      { silent: true },
    );
    const draft = await readCachedResource<{ from: string }>(
      "meeting_draft",
      "shared-id",
      { silent: true },
    );
    expect(brief!.data.from).toBe("brief");
    expect(draft!.data.from).toBe("draft");
  });

  it("clearResource only removes the specified (type, id) pair", async () => {
    await cacheResource("brief", "s1", { title: "b" });
    await cacheResource("meeting_draft", "s1", { title: "d" });
    await clearResource("brief", "s1");

    expect(
      await readCachedResource("brief", "s1", { silent: true }),
    ).toBeNull();
    const draft = await readCachedResource<{ title: string }>(
      "meeting_draft",
      "s1",
      { silent: true },
    );
    expect(draft!.data.title).toBe("d");
  });
});

describe("offline-cache — listCachedResources filters by type", () => {
  it("returns only entries of the requested type, newest first", async () => {
    const t0 = 2_000_000_000_000;
    const nowSpy = jest.spyOn(Date, "now");
    nowSpy.mockReturnValue(t0);
    await cacheResource("meeting_draft", "a", { title: "A" });
    nowSpy.mockReturnValue(t0 + 1000);
    await cacheResource("meeting_draft", "b", { title: "B" });
    nowSpy.mockReturnValue(t0 + 2000);
    await cacheResource("brief", "s1", { title: "S" });

    const drafts = await listCachedResources("meeting_draft");
    expect(drafts.map((d) => d.resource_id)).toEqual(["b", "a"]);
    expect(drafts.every((d) => d.resource_type === "meeting_draft")).toBe(
      true,
    );

    const briefs = await listCachedResources("brief");
    expect(briefs).toHaveLength(1);
    expect(briefs[0].resource_id).toBe("s1");
  });

  it("returns empty array when no entries match", async () => {
    await cacheResource("brief", "s1", {});
    const drafts = await listCachedResources("meeting_draft");
    expect(drafts).toEqual([]);
  });
});

describe("offline-cache — analytics", () => {
  it("fires offline.resource_served_from_cache on read hit", async () => {
    const t0 = 3_000_000_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    await cacheResource("hr_doc_pending", "doc-7", { title: "W2" });
    nowSpy.mockReturnValue(t0 + 12_000);

    const emitted: Array<[string, Record<string, string | number | boolean>]> = [];
    await readCachedResource("hr_doc_pending", "doc-7", {
      onAnalytics: (e, m) => emitted.push([e, m]),
    });
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe("offline.resource_served_from_cache");
    expect(emitted[0][1]).toEqual({
      resource_type: "hr_doc_pending",
      resource_id: "doc-7",
      cache_age_ms: 12_000,
    });
  });

  it("also fires legacy offline.brief_served_from_cache when opted in + type=brief", async () => {
    const t0 = 4_000_000_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    await cacheResource("brief", "site-z", { title: "z" });
    nowSpy.mockReturnValue(t0 + 500);

    const emitted: Array<[string, Record<string, string | number | boolean>]> = [];
    await readCachedResource("brief", "site-z", {
      onAnalytics: (e, m) => emitted.push([e, m]),
      emitLegacyBriefEvent: true,
    });
    const eventNames = emitted.map(([e]) => e).sort();
    expect(eventNames).toEqual([
      "offline.brief_served_from_cache",
      "offline.resource_served_from_cache",
    ]);
    const legacy = emitted.find(([e]) => e === "offline.brief_served_from_cache")!;
    expect(legacy[1]).toEqual({ site_id: "site-z", cache_age_ms: 500 });
  });

  it("silent=true suppresses all analytics", async () => {
    await cacheResource("journal_entry", "j-1", {});
    const emitted: Array<[string, unknown]> = [];
    await readCachedResource("journal_entry", "j-1", {
      silent: true,
      onAnalytics: (e, m) => emitted.push([e, m]),
    });
    expect(emitted).toHaveLength(0);
  });

  it("no analytics fire on a cache miss", async () => {
    const emitted: Array<[string, unknown]> = [];
    const rec = await readCachedResource("meeting_draft", "nope", {
      onAnalytics: (e, m) => emitted.push([e, m]),
    });
    expect(rec).toBeNull();
    expect(emitted).toHaveLength(0);
  });
});

describe("offline-cache — getResourceAgeMs", () => {
  it("reports accurate cache_age_ms without firing analytics", async () => {
    const t0 = 5_000_000_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    await cacheResource("journal_entry", "j-age", { body: "x" });
    nowSpy.mockReturnValue(t0 + 90_000);
    const age = await getResourceAgeMs("journal_entry", "j-age");
    expect(age).toBe(90_000);
  });

  it("returns null when the resource is missing", async () => {
    expect(
      await getResourceAgeMs("meeting_draft", "does-not-exist"),
    ).toBeNull();
  });
});

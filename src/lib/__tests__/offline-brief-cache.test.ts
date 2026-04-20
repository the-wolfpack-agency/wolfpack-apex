/**
 * @jest-environment jsdom
 *
 * Offline brief cache — write on success, read on offline cold-load,
 * cache_age_ms accurate, analytics fire on hit.
 */

import "fake-indexeddb/auto";
import {
  saveBriefSnapshot,
  readBriefSnapshot,
  getCacheAgeMs,
  deleteBriefSnapshot,
  clearAllBriefs,
  __resetForTests,
} from "@/lib/offline-brief-cache";

interface FakeBrief {
  title: string;
  hero: string;
}

beforeEach(async () => {
  __resetForTests();
  await clearAllBriefs();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
});

afterEach(async () => {
  await clearAllBriefs();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe("offline-brief-cache", () => {
  it("returns null for an un-cached site", async () => {
    const rec = await readBriefSnapshot<FakeBrief>("site-missing", { silent: true });
    expect(rec).toBeNull();
  });

  it("persists a brief and reads it back with the same payload", async () => {
    const brief: FakeBrief = { title: "Hello", hero: "World" };
    await saveBriefSnapshot("site-1", brief);

    const rec = await readBriefSnapshot<FakeBrief>("site-1", { silent: true });
    expect(rec).not.toBeNull();
    expect(rec!.site_id).toBe("site-1");
    expect(rec!.brief).toEqual(brief);
    expect(rec!.fetched_at).toBeGreaterThan(0);
  });

  it("overwrites older snapshots on subsequent save (keyPath=site_id)", async () => {
    await saveBriefSnapshot("site-1", { title: "v1", hero: "a" });
    await saveBriefSnapshot("site-1", { title: "v2", hero: "b" });
    const rec = await readBriefSnapshot<FakeBrief>("site-1", { silent: true });
    expect(rec!.brief).toEqual({ title: "v2", hero: "b" });
  });

  it("reports accurate cache_age_ms via getCacheAgeMs", async () => {
    const t0 = 2_000_000_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    await saveBriefSnapshot("site-age", { title: "x", hero: "y" });
    nowSpy.mockReturnValue(t0 + 45_000);
    const age = await getCacheAgeMs("site-age");
    expect(age).toBe(45_000);
  });

  it("fires offline.brief_served_from_cache analytics on read hit", async () => {
    const t0 = 3_000_000_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    await saveBriefSnapshot("site-k", { title: "t", hero: "h" });
    nowSpy.mockReturnValue(t0 + 12345);

    const emitted: Array<[string, Record<string, string | number | boolean>]> = [];
    const rec = await readBriefSnapshot<FakeBrief>("site-k", {
      onAnalytics: (e, m) => emitted.push([e, m]),
    });
    expect(rec).not.toBeNull();
    expect(emitted).toHaveLength(1);
    expect(emitted[0][0]).toBe("offline.brief_served_from_cache");
    expect(emitted[0][1]).toEqual({ site_id: "site-k", cache_age_ms: 12345 });
  });

  it("does not fire analytics in silent mode", async () => {
    await saveBriefSnapshot("site-silent", { title: "t", hero: "h" });
    const emitted: Array<[string, unknown]> = [];
    await readBriefSnapshot("site-silent", {
      silent: true,
      onAnalytics: (e, m) => emitted.push([e, m]),
    });
    expect(emitted).toHaveLength(0);
  });

  it("does not fire analytics on a miss", async () => {
    const emitted: Array<[string, unknown]> = [];
    const rec = await readBriefSnapshot("site-nope", {
      onAnalytics: (e, m) => emitted.push([e, m]),
    });
    expect(rec).toBeNull();
    expect(emitted).toHaveLength(0);
  });

  it("deleteBriefSnapshot removes a single site without affecting others", async () => {
    await saveBriefSnapshot("a", { title: "a", hero: "a" });
    await saveBriefSnapshot("b", { title: "b", hero: "b" });
    await deleteBriefSnapshot("a");
    expect(await readBriefSnapshot("a", { silent: true })).toBeNull();
    const rec = await readBriefSnapshot<FakeBrief>("b", { silent: true });
    expect(rec!.brief.title).toBe("b");
  });
});

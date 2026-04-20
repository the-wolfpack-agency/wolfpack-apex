/**
 * @jest-environment jsdom
 *
 * brain-pack-store — IDB cache contract tests.
 */

import "fake-indexeddb/auto";

import {
  CachedChunk,
  clearPack,
  getCachedChunkById,
  getCachedChunks,
  getPackStats,
  putCachedChunks,
  PackQuotaExceededError,
  __forceMemoryFallbackForTests,
  __resetBrainPackStoreForTests,
} from "@/lib/brain-pack-store";

function makeChunk(
  id: string,
  workspace = "default",
  overrides: Partial<CachedChunk> = {},
): CachedChunk {
  return {
    id,
    doc_id: `doc-${id}`,
    title: `Doc ${id}.pdf`,
    text: `body of ${id}`,
    embedding: [0.1, 0.2, 0.3],
    workspace,
    cached_at: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  __resetBrainPackStoreForTests();
});

afterEach(async () => {
  // Wipe the in-memory fallback store between tests to avoid leakage.
  __resetBrainPackStoreForTests();
});

describe("brain-pack-store — IDB round trip", () => {
  it("stores and reads back chunks filtered by workspace", async () => {
    await putCachedChunks([
      makeChunk("c1", "default"),
      makeChunk("c2", "default"),
      makeChunk("c3", "other-ws"),
    ]);

    const defRows = await getCachedChunks("default");
    expect(defRows).toHaveLength(2);
    expect(defRows.map((r) => r.id).sort()).toEqual(["c1", "c2"]);

    const otherRows = await getCachedChunks("other-ws");
    expect(otherRows).toHaveLength(1);
    expect(otherRows[0].id).toBe("c3");
  });

  it("getCachedChunkById resolves a single id regardless of workspace", async () => {
    await putCachedChunks([makeChunk("abc", "default")]);
    const got = await getCachedChunkById("abc");
    expect(got?.doc_id).toBe("doc-abc");
    const missing = await getCachedChunkById("not-there");
    expect(missing).toBeNull();
  });

  it("put upsert overwrites existing rows", async () => {
    await putCachedChunks([makeChunk("c1", "default", { text: "v1" })]);
    await putCachedChunks([makeChunk("c1", "default", { text: "v2" })]);
    const got = await getCachedChunkById("c1");
    expect(got?.text).toBe("v2");
  });

  it("clearPack removes only the requested workspace", async () => {
    await putCachedChunks([
      makeChunk("c1", "default"),
      makeChunk("c2", "other"),
    ]);
    await clearPack("default");
    expect(await getCachedChunks("default")).toHaveLength(0);
    expect(await getCachedChunks("other")).toHaveLength(1);
  });
});

describe("brain-pack-store — stats", () => {
  it("getPackStats reports count + bytes + bounds", async () => {
    const t0 = 1_700_000_000_000;
    await putCachedChunks([
      makeChunk("c1", "default", { cached_at: t0, embedding: [1, 2, 3, 4] }),
      makeChunk("c2", "default", { cached_at: t0 + 1000, embedding: [5, 6] }),
    ]);

    const stats = await getPackStats("default");
    expect(stats.chunk_count).toBe(2);
    expect(stats.total_bytes).toBeGreaterThan(0);
    expect(stats.oldest_cached_at).toBe(t0);
    expect(stats.newest_cached_at).toBe(t0 + 1000);
  });

  it("getPackStats returns zeroed baseline when pack is empty", async () => {
    const stats = await getPackStats("default");
    expect(stats).toEqual({
      chunk_count: 0,
      total_bytes: 0,
      oldest_cached_at: null,
      newest_cached_at: null,
    });
  });
});

describe("brain-pack-store — quota handling", () => {
  it("throws PackQuotaExceededError when IDB raises QuotaExceededError", async () => {
    // Force memory fallback off and mock openDB to yield a transaction
    // whose `put` throws a QuotaExceededError.
    __resetBrainPackStoreForTests();
    const originalOpen = indexedDB.open.bind(indexedDB);
    const fakeStore = {
      put: jest.fn().mockImplementation(() => {
        const err = new Error("quota") as Error & { name: string; code: number };
        err.name = "QuotaExceededError";
        err.code = 22;
        throw err;
      }),
    };
    const fakeTx = {
      objectStore: () => fakeStore,
      oncomplete: null as null | (() => void),
      onerror: null as null | (() => void),
      onabort: null as null | (() => void),
      error: null as unknown,
    };
    const fakeDb = {
      transaction: () => fakeTx,
    };
    const openSpy = jest.spyOn(indexedDB, "open").mockImplementation(((
      _name: string,
      _version: number,
    ) => {
      const req: Partial<IDBOpenDBRequest> & {
        result: unknown;
        onsuccess: null | (() => void);
      } = {
        result: fakeDb,
        onupgradeneeded: null,
        onerror: null,
        onsuccess: null,
      };
      setTimeout(() => req.onsuccess?.(), 0);
      return req as IDBOpenDBRequest;
    }) as typeof indexedDB.open);

    await expect(
      putCachedChunks([makeChunk("q1", "default")]),
    ).rejects.toBeInstanceOf(PackQuotaExceededError);

    openSpy.mockRestore();
    // Restore so subsequent tests get a clean DB.
    void originalOpen;
  });
});

describe("brain-pack-store — memory fallback", () => {
  it("works without IDB (Safari private-mode parity)", async () => {
    __resetBrainPackStoreForTests();
    __forceMemoryFallbackForTests();

    await putCachedChunks([
      makeChunk("m1", "default"),
      makeChunk("m2", "default"),
      makeChunk("m3", "other"),
    ]);

    const rows = await getCachedChunks("default");
    expect(rows).toHaveLength(2);
    expect(await getCachedChunkById("m3")).not.toBeNull();

    await clearPack("default");
    expect(await getCachedChunks("default")).toHaveLength(0);
    expect(await getCachedChunks("other")).toHaveLength(1);
  });
});

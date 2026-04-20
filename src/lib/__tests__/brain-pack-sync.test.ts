/**
 * @jest-environment jsdom
 *
 * brain-pack-sync — progressive downloader contract tests.
 */

import "fake-indexeddb/auto";

import {
  __resetBrainPackSyncForTests,
  startAmbientPackSync,
  syncBrainPack,
} from "@/lib/brain-pack-sync";
import {
  __resetBrainPackStoreForTests,
  clearPack,
  getCachedChunks,
  putCachedChunks,
  PackQuotaExceededError,
  type CachedChunk,
} from "@/lib/brain-pack-store";

type AnalyticsRecord = [string, Record<string, string | number | boolean>];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "Content-Type": "application/json" }),
  } as unknown as Response;
}

interface ServerChunk {
  id: string;
  doc_id: string;
  title: string;
  text: string;
  embedding: number[];
}

function makeServerChunk(id: string): ServerChunk {
  return {
    id,
    doc_id: `doc-${id}`,
    title: `Title ${id}`,
    text: `body of ${id}`,
    embedding: [0.1, 0.2],
  };
}

beforeEach(async () => {
  __resetBrainPackSyncForTests();
  __resetBrainPackStoreForTests();
  await clearPack("default").catch(() => undefined);

  // Baseline navigator.onLine = true, no saveData / cellular.
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    get: () => true,
  });
  (window.navigator as unknown as { connection?: unknown }).connection =
    undefined;
});

afterEach(async () => {
  __resetBrainPackSyncForTests();
  __resetBrainPackStoreForTests();
  jest.restoreAllMocks();
});

describe("syncBrainPack — happy path", () => {
  it("pages through cursor and writes every chunk to IDB", async () => {
    const pages = [
      {
        chunks: [makeServerChunk("a"), makeServerChunk("b")],
        next_cursor: "b",
        total: 3,
      },
      {
        chunks: [makeServerChunk("c")],
        next_cursor: null,
        total: 3,
      },
    ];
    let page = 0;
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockImplementation(async (_url: string) =>
        jsonResponse(pages[page++]),
      );

    const events: AnalyticsRecord[] = [];

    const result = await syncBrainPack("default", {
      pageDelayMs: 0,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(result.downloaded).toBe(3);
    expect(result.failed).toBe(0);
    const cached = await getCachedChunks("default");
    expect(cached.map((c) => c.id).sort()).toEqual(["a", "b", "c"]);

    const names = events.map((e) => e[0]);
    expect(names).toContain("brain.pack_sync_started");
    expect(names.filter((n) => n === "brain.pack_page_downloaded").length).toBe(
      2,
    );
    expect(names).toContain("brain.pack_sync_completed");
  });

  it("passes the workspace + cursor on the URL", async () => {
    const urls: string[] = [];
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockImplementation(async (url: string) => {
        urls.push(url);
        if (urls.length === 1) {
          return jsonResponse({
            chunks: [makeServerChunk("a")],
            next_cursor: "a",
            total: 2,
          });
        }
        return jsonResponse({
          chunks: [makeServerChunk("b")],
          next_cursor: null,
          total: 2,
        });
      });

    await syncBrainPack("default", {
      pageDelayMs: 0,
      fetcher: fetcher as unknown as typeof fetch,
    });

    expect(urls[0]).toMatch(/\/api\/brain\/pack\?/);
    expect(urls[0]).toMatch(/workspace=default/);
    expect(urls[0]).not.toMatch(/cursor=/);
    expect(urls[1]).toMatch(/cursor=a/);
  });
});

describe("syncBrainPack — resumable", () => {
  it("carries cursor forward across calls via module-level state", async () => {
    const pages = [
      {
        chunks: [makeServerChunk("a")],
        next_cursor: "a",
        total: 2,
      },
    ];
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockImplementation(async () => jsonResponse(pages[0]));
    const ctrl = new AbortController();

    // First run — we abort right after the first page lands.
    const first = syncBrainPack("default", {
      pageDelayMs: 50,
      fetcher: fetcher as unknown as typeof fetch,
      signal: ctrl.signal,
    });
    // Abort shortly so only one page is served.
    setTimeout(() => ctrl.abort(), 10);
    await first;

    // Second run — cursor should be pre-populated; the next fetch URL
    // must include cursor=a.
    const urls: string[] = [];
    const fetcher2 = jest
      .fn<Promise<Response>, [string]>()
      .mockImplementation(async (url: string) => {
        urls.push(url);
        return jsonResponse({
          chunks: [makeServerChunk("b")],
          next_cursor: null,
          total: 2,
        });
      });

    await syncBrainPack("default", {
      pageDelayMs: 0,
      fetcher: fetcher2 as unknown as typeof fetch,
    });
    expect(urls[0]).toMatch(/cursor=a/);
  });
});

describe("syncBrainPack — connection-aware skips", () => {
  it("skips with reason=offline when navigator.onLine is false", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      get: () => false,
    });
    const events: AnalyticsRecord[] = [];
    const fetcher = jest.fn();

    const res = await syncBrainPack("default", {
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    expect(res.downloaded).toBe(0);
    expect(fetcher).not.toHaveBeenCalled();
    expect(events[0][0]).toBe("brain.pack_sync_skipped");
    expect(events[0][1].reason).toBe("offline");
  });

  it("skips with reason=save_data when saveData is true", async () => {
    (window.navigator as unknown as { connection?: unknown }).connection = {
      saveData: true,
    };
    const events: AnalyticsRecord[] = [];
    const fetcher = jest.fn();

    const res = await syncBrainPack("default", {
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    expect(res.downloaded).toBe(0);
    expect(events[0][1].reason).toBe("save_data");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("skips with reason=cellular unless allowCellular opt-in", async () => {
    (window.navigator as unknown as { connection?: unknown }).connection = {
      type: "cellular",
    };
    const events: AnalyticsRecord[] = [];
    const fetcher = jest.fn();
    const res = await syncBrainPack("default", {
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    expect(res.downloaded).toBe(0);
    expect(events[0][1].reason).toBe("cellular");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("allows cellular when allowCellular=true", async () => {
    (window.navigator as unknown as { connection?: unknown }).connection = {
      type: "cellular",
    };
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockResolvedValue(
        jsonResponse({ chunks: [], next_cursor: null, total: 0 }),
      );
    const res = await syncBrainPack("default", {
      allowCellular: true,
      pageDelayMs: 0,
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(res.failed).toBe(0);
    expect(fetcher).toHaveBeenCalled();
  });
});

describe("syncBrainPack — dedup window", () => {
  it("refuses a second concurrent sync for the same workspace", async () => {
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockImplementation(async () => {
        // Deliberately slow so dedup races.
        await new Promise((r) => setTimeout(r, 25));
        return jsonResponse({ chunks: [], next_cursor: null, total: 0 });
      });

    const events: AnalyticsRecord[] = [];
    const first = syncBrainPack("default", {
      pageDelayMs: 0,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    const second = await syncBrainPack("default", {
      pageDelayMs: 0,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    await first;

    expect(second.skipped).toBe(1);
    const skipEvent = events.find(
      (e) =>
        e[0] === "brain.pack_sync_skipped" && e[1].reason === "already_running",
    );
    expect(skipEvent).toBeDefined();
  });
});

describe("syncBrainPack — abortable", () => {
  it("stops mid-sync when the signal aborts", async () => {
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockImplementation(async () => {
        return jsonResponse({
          chunks: [makeServerChunk("x")],
          next_cursor: "x",
          total: 999,
        });
      });
    const ctrl = new AbortController();

    const promise = syncBrainPack("default", {
      pageDelayMs: 30,
      fetcher: fetcher as unknown as typeof fetch,
      signal: ctrl.signal,
    });

    // Let at least one page land, then abort.
    setTimeout(() => ctrl.abort(), 10);

    const res = await promise;
    // At least one page downloaded before abort; no infinite loop.
    expect(res.downloaded).toBeGreaterThan(0);
    expect(fetcher.mock.calls.length).toBeLessThan(10);
  });
});

describe("syncBrainPack — quota exceeded", () => {
  it("emits pack_sync_skipped reason=quota_exceeded on QuotaExceededError", async () => {
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockResolvedValue(
        jsonResponse({
          chunks: [makeServerChunk("q1")],
          next_cursor: "q1",
          total: 1,
        }),
      );

    // Force putCachedChunks to raise PackQuotaExceededError.
    const mod = await import("@/lib/brain-pack-store");
    const spy = jest
      .spyOn(mod, "putCachedChunks")
      .mockImplementation(async (): Promise<{ written: number; skipped: number }> => {
        throw new PackQuotaExceededError();
      });

    const events: AnalyticsRecord[] = [];
    const res = await syncBrainPack("default", {
      pageDelayMs: 0,
      fetcher: fetcher as unknown as typeof fetch,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    expect(res.skipped).toBeGreaterThanOrEqual(1);
    const quota = events.find(
      (e) =>
        e[0] === "brain.pack_sync_skipped" && e[1].reason === "quota_exceeded",
    );
    expect(quota).toBeDefined();
    spy.mockRestore();
  });
});

describe("syncBrainPack — rate limiting", () => {
  it("delays between pages by pageDelayMs", async () => {
    const pages: Array<{
      chunks: ServerChunk[];
      next_cursor: string | null;
      total: number;
    }> = [
      {
        chunks: [makeServerChunk("a")],
        next_cursor: "a",
        total: 2,
      },
      {
        chunks: [makeServerChunk("b")],
        next_cursor: null,
        total: 2,
      },
    ];
    let i = 0;
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockImplementation(async () => jsonResponse(pages[i++]));

    const t0 = Date.now();
    await syncBrainPack("default", {
      pageDelayMs: 60,
      fetcher: fetcher as unknown as typeof fetch,
    });
    const elapsed = Date.now() - t0;
    // Two pages → at least one delay of ~60ms.
    expect(elapsed).toBeGreaterThanOrEqual(50);
  });
});

describe("startAmbientPackSync", () => {
  it("returns a stop handle that clears timers + listeners", async () => {
    const handle = startAmbientPackSync("default");
    expect(typeof handle.stop).toBe("function");
    // Must not throw when stopping before any sync actually fired.
    handle.stop();
    handle.stop(); // idempotent
  });
});

// ---------------------------------------------------------------------------
// Ensure the pre-populated cache shown by getCachedChunks is used by the
// test between rounds — this is the round-trip the downloader relies on.
// ---------------------------------------------------------------------------

describe("syncBrainPack → getCachedChunks round trip", () => {
  it("cached chunks are readable after a sync completes", async () => {
    const fetcher = jest
      .fn<Promise<Response>, [string]>()
      .mockResolvedValue(
        jsonResponse({
          chunks: [makeServerChunk("r1"), makeServerChunk("r2")],
          next_cursor: null,
          total: 2,
        }),
      );

    await syncBrainPack("default", {
      pageDelayMs: 0,
      fetcher: fetcher as unknown as typeof fetch,
    });

    const rows = await getCachedChunks("default");
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.workspace === "default")).toBe(true);
    expect(rows.every((r) => Array.isArray(r.embedding))).toBe(true);
  });

  it("can be seeded directly for UI-only tests", async () => {
    const now = Date.now();
    const seeded: CachedChunk = {
      id: "seed",
      doc_id: "d1",
      title: "x",
      text: "t",
      embedding: [0, 0, 0],
      workspace: "default",
      cached_at: now,
    };
    await putCachedChunks([seeded]);
    const back = await getCachedChunks("default");
    expect(back[0].id).toBe("seed");
  });
});

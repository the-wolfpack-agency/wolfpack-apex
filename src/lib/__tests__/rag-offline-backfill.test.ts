/**
 * @jest-environment jsdom
 *
 * rag-offline-backfill — ambient doc-body backfill orchestrator.
 *
 * Covers the Stream U5 follow-up contract:
 *   1. scheduleDocBodyBackfill returns synchronously (non-blocking).
 *   2. scheduleDocBodyBackfill never throws, even when everything
 *      downstream does.
 *   3. Top-K limit is honored (sources=10, topK=3 → 3 fetches).
 *   4. Dedup skips recently-cached docs + emits correct reason.
 *   5. Concurrency cap honored — fire 10 simultaneously, at most 3
 *      in-flight.
 *   6. Timeout path skips the stuck doc, does not block peers.
 *   7. Failed fetch emits rag.doc_backfill_skipped (does not throw).
 *   8. readCachedDocBody round-trip.
 *   9. no-endpoint scopes emit skipped with reason=no_endpoint.
 *  10. Analytics events fire with correct metadata.
 *  11. completed event summarizes the batch.
 */

import "fake-indexeddb/auto";
import {
  scheduleDocBodyBackfill,
  backfillDocBodies,
  readCachedDocBody,
  __resetBackfillForTests,
  __getBackfillPeakInFlight,
} from "@/lib/rag-offline-backfill";
import {
  clearAllResources,
  __resetForTests,
} from "@/lib/offline-cache";

type AnalyticsEvent = [string, Record<string, string | number | boolean>];

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "Content-Type": "application/json" }),
  } as unknown as Response;
}

function brainDocResponse(docId: string, chunkContents: string[]): Response {
  return jsonResponse({
    document: { id: docId, filename: `${docId}.pdf` },
    chunks: chunkContents.map((content, i) => ({
      chunk_id: `${docId}-c${i}`,
      chunk_idx: i,
      content,
    })),
  });
}

beforeEach(async () => {
  __resetForTests();
  __resetBackfillForTests();
  await clearAllResources();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
});

afterEach(async () => {
  await clearAllResources();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Invariant 1 — non-blocking
// ---------------------------------------------------------------------------

describe("scheduleDocBodyBackfill — non-blocking", () => {
  it("returns synchronously before any fetch is issued", () => {
    const fetcher = jest.fn().mockResolvedValue(
      brainDocResponse("d-1", ["hello"]),
    );
    const result = scheduleDocBodyBackfill(
      "brain",
      [{ id: "d-1" }],
      { fetcher: fetcher as unknown as typeof fetch },
    );
    // Return type is void; the fact that this line runs proves sync
    // return. Fetch must not have fired yet — we kick it on microtask.
    expect(result).toBeUndefined();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("never throws, even if sources is malformed", () => {
    // @ts-expect-error intentional — exercise the try/catch
    expect(() => scheduleDocBodyBackfill("brain", null)).not.toThrow();
    // @ts-expect-error intentional
    expect(() => scheduleDocBodyBackfill("brain", undefined)).not.toThrow();
    expect(() => scheduleDocBodyBackfill("brain", [])).not.toThrow();
  });

  it("never throws even if the fetcher throws synchronously", async () => {
    const fetcher = jest.fn(() => {
      throw new Error("nope");
    });
    expect(() =>
      scheduleDocBodyBackfill(
        "brain",
        [{ id: "d-1" }],
        { fetcher: fetcher as unknown as typeof fetch },
      ),
    ).not.toThrow();
    // Let microtasks drain.
    await new Promise((r) => setTimeout(r, 10));
  });
});

// ---------------------------------------------------------------------------
// Invariant 3 — top-K
// ---------------------------------------------------------------------------

describe("backfillDocBodies — top-K limit", () => {
  it("attempts only topK sources when more are supplied", async () => {
    const fetcher = jest.fn((url: string) => {
      const match = /documents\/(d-\d+)/.exec(url);
      const id = match ? match[1] : "unknown";
      return Promise.resolve(brainDocResponse(id, ["body"]));
    });
    const sources = Array.from({ length: 10 }, (_, i) => ({ id: `d-${i}` }));
    const summary = await backfillDocBodies("brain", sources, {
      fetcher: fetcher as unknown as typeof fetch,
      topK: 3,
    });
    expect(summary.attempted).toBe(3);
    expect(summary.cached).toBe(3);
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("default topK is 3", async () => {
    const fetcher = jest.fn((url: string) => {
      const match = /documents\/(d-\d+)/.exec(url);
      return Promise.resolve(
        brainDocResponse(match ? match[1] : "x", ["b"]),
      );
    });
    const sources = Array.from({ length: 5 }, (_, i) => ({ id: `d-${i}` }));
    const summary = await backfillDocBodies("brain", sources, {
      fetcher: fetcher as unknown as typeof fetch,
    });
    expect(summary.attempted).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Invariant 4 — dedup
// ---------------------------------------------------------------------------

describe("backfillDocBodies — dedup", () => {
  it("skips a recently-cached doc and emits recent_cache_hit", async () => {
    const events: AnalyticsEvent[] = [];

    // First pass — populate cache.
    const fetcher1 = jest.fn(() =>
      Promise.resolve(brainDocResponse("d-1", ["body-1"])),
    );
    await backfillDocBodies(
      "brain",
      [{ id: "d-1" }],
      {
        fetcher: fetcher1 as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      },
    );
    expect(fetcher1).toHaveBeenCalledTimes(1);

    // Second pass — should dedup.
    const fetcher2 = jest.fn(() =>
      Promise.resolve(brainDocResponse("d-1", ["body-2-UPDATED"])),
    );
    const events2: AnalyticsEvent[] = [];
    const summary = await backfillDocBodies(
      "brain",
      [{ id: "d-1" }],
      {
        fetcher: fetcher2 as unknown as typeof fetch,
        onAnalytics: (e, m) => events2.push([e, m]),
      },
    );
    expect(fetcher2).not.toHaveBeenCalled();
    expect(summary.cached).toBe(0);
    expect(summary.skipped).toBe(1);
    const skipped = events2.find(([e]) => e === "rag.doc_backfill_skipped");
    expect(skipped).toBeDefined();
    expect(skipped![1].reason).toBe("recent_cache_hit");
  });

  it("re-fetches when the cached entry is older than maxAgeMs", async () => {
    // Use `now` to control age.
    const t0 = 1_000_000;
    let clock = t0;
    const now = () => clock;

    const fetcher = jest.fn((url: string) => {
      const match = /documents\/(d-\d+)/.exec(url);
      return Promise.resolve(
        brainDocResponse(match ? match[1] : "x", ["fresh"]),
      );
    });

    await backfillDocBodies(
      "brain",
      [{ id: "d-1" }],
      { fetcher: fetcher as unknown as typeof fetch, now, maxAgeMs: 1000 },
    );
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Advance beyond dedup window.
    clock = t0 + 2_000;
    await backfillDocBodies(
      "brain",
      [{ id: "d-1" }],
      { fetcher: fetcher as unknown as typeof fetch, now, maxAgeMs: 1000 },
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// Invariant 5 — concurrency cap
// ---------------------------------------------------------------------------

describe("backfillDocBodies — concurrency cap", () => {
  it("never exceeds the configured concurrency", async () => {
    // 10 sources, cap 3. The fetcher resolves only after we release it.
    const pending: Array<() => void> = [];
    let observedPeak = 0;
    let inFlight = 0;

    const fetcher = jest.fn((url: string) => {
      inFlight += 1;
      if (inFlight > observedPeak) observedPeak = inFlight;
      const match = /documents\/(d-\d+)/.exec(url);
      const id = match ? match[1] : "x";
      return new Promise<Response>((resolve) => {
        pending.push(() => {
          inFlight -= 1;
          resolve(brainDocResponse(id, ["body"]));
        });
      });
    });

    const sources = Array.from({ length: 10 }, (_, i) => ({ id: `d-${i}` }));
    const run = backfillDocBodies("brain", sources, {
      fetcher: fetcher as unknown as typeof fetch,
      topK: 10,
      maxConcurrency: 3,
    });

    // Let the queue saturate.
    await new Promise((r) => setTimeout(r, 20));
    expect(observedPeak).toBeLessThanOrEqual(3);
    expect(fetcher).toHaveBeenCalledTimes(3);

    // Drain.
    while (pending.length > 0) {
      const next = pending.shift()!;
      next();
      await new Promise((r) => setTimeout(r, 5));
    }

    const summary = await run;
    expect(summary.cached).toBe(10);
    expect(observedPeak).toBeLessThanOrEqual(3);
  });

  it("uses the shared global semaphore for default-cap schedules", async () => {
    __resetBackfillForTests(3);
    const pending: Array<() => void> = [];
    let inFlight = 0;
    let observedPeak = 0;

    const fetcher = jest.fn((url: string) => {
      inFlight += 1;
      if (inFlight > observedPeak) observedPeak = inFlight;
      const match = /documents\/(d-\d+)/.exec(url);
      const id = match ? match[1] : "x";
      return new Promise<Response>((resolve) => {
        pending.push(() => {
          inFlight -= 1;
          resolve(brainDocResponse(id, ["body"]));
        });
      });
    });

    // Two schedule calls, 5 sources each. Global cap should clamp to 3
    // even across both batches.
    const p1 = backfillDocBodies(
      "brain",
      Array.from({ length: 5 }, (_, i) => ({ id: `a-${i}` })),
      { fetcher: fetcher as unknown as typeof fetch, topK: 5 },
    );
    const p2 = backfillDocBodies(
      "brain",
      Array.from({ length: 5 }, (_, i) => ({ id: `b-${i}` })),
      { fetcher: fetcher as unknown as typeof fetch, topK: 5 },
    );

    await new Promise((r) => setTimeout(r, 20));
    expect(observedPeak).toBeLessThanOrEqual(3);

    // Drain all.
    while (pending.length > 0) {
      const next = pending.shift()!;
      next();
      await new Promise((r) => setTimeout(r, 2));
    }
    await Promise.all([p1, p2]);
    expect(observedPeak).toBeLessThanOrEqual(3);
    expect(__getBackfillPeakInFlight()).toBeLessThanOrEqual(3);
  });
});

// ---------------------------------------------------------------------------
// Invariant 6 — timeout isolation
// ---------------------------------------------------------------------------

describe("backfillDocBodies — timeout isolation", () => {
  it("skips the stuck doc without stalling peers", async () => {
    // We use REAL timers — fake timers + fake-indexeddb interact
    // unpredictably because IDB request completion is microtask-driven
    // and can end up out-of-order with the timeout race. Short real
    // timeout (50ms) is plenty for test speed.
    const fetcher = jest.fn((url: string) => {
      const match = /documents\/(d-\w+)/.exec(url);
      const id = match ? match[1] : "x";
      if (id === "d-stuck") {
        return new Promise<Response>(() => {
          /* hangs forever */
        });
      }
      return Promise.resolve(brainDocResponse(id, ["body"]));
    });

    const events: AnalyticsEvent[] = [];
    const summary = await backfillDocBodies(
      "brain",
      [{ id: "d-stuck" }, { id: "d-ok" }],
      {
        fetcher: fetcher as unknown as typeof fetch,
        topK: 2,
        timeoutMs: 50,
        maxConcurrency: 2,
        onAnalytics: (e, m) => events.push([e, m]),
      },
    );

    expect(summary.attempted).toBe(2);
    expect(summary.cached).toBe(1);
    expect(summary.skipped).toBe(1);
    expect(
      events.some(
        ([e, m]) =>
          e === "rag.doc_backfill_skipped" &&
          m.reason === "timeout" &&
          m.doc_id === "d-stuck",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 7 — failed fetch
// ---------------------------------------------------------------------------

describe("backfillDocBodies — failed fetch", () => {
  it("emits skipped with reason=fetch_failed on 500", async () => {
    const fetcher = jest.fn().mockResolvedValue(
      jsonResponse({ error: "boom" }, 500),
    );
    const events: AnalyticsEvent[] = [];
    const summary = await backfillDocBodies(
      "brain",
      [{ id: "d-bad" }],
      {
        fetcher: fetcher as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      },
    );
    expect(summary.failed).toBe(1);
    expect(summary.cached).toBe(0);
    expect(
      events.some(
        ([e, m]) =>
          e === "rag.doc_backfill_skipped" && m.reason === "fetch_failed",
      ),
    ).toBe(true);
  });

  it("does not throw when the fetcher rejects", async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error("offline"));
    const events: AnalyticsEvent[] = [];
    await expect(
      backfillDocBodies(
        "brain",
        [{ id: "d-err" }],
        {
          fetcher: fetcher as unknown as typeof fetch,
          onAnalytics: (e, m) => events.push([e, m]),
        },
      ),
    ).resolves.toMatchObject({ failed: 1 });
    expect(
      events.some(
        ([e, m]) =>
          e === "rag.doc_backfill_skipped" && m.reason === "fetch_failed",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 8 — readCachedDocBody round-trip
// ---------------------------------------------------------------------------

describe("readCachedDocBody", () => {
  it("returns null when nothing is cached", async () => {
    const body = await readCachedDocBody("nope");
    expect(body).toBeNull();
  });

  it("reads back a body that was just backfilled", async () => {
    const fetcher = jest.fn((url: string) => {
      const match = /documents\/(d-\d+)/.exec(url);
      const id = match ? match[1] : "x";
      return Promise.resolve(brainDocResponse(id, ["chapter 1", "chapter 2"]));
    });
    await backfillDocBodies(
      "brain",
      [{ id: "d-42", title: "The Answer" }],
      { fetcher: fetcher as unknown as typeof fetch },
    );
    const body = await readCachedDocBody("d-42", "brain");
    expect(body).not.toBeNull();
    expect(body!.id).toBe("d-42");
    expect(body!.scope).toBe("brain");
    expect(body!.content).toBe("chapter 1\n\nchapter 2");
    expect(body!.title).toBe("The Answer");
  });

  it("finds a body when scope is omitted", async () => {
    const fetcher = jest.fn((url: string) => {
      const match = /documents\/(d-\d+)/.exec(url);
      const id = match ? match[1] : "x";
      return Promise.resolve(brainDocResponse(id, ["body"]));
    });
    await backfillDocBodies(
      "brain",
      [{ id: "d-7" }],
      { fetcher: fetcher as unknown as typeof fetch },
    );
    const body = await readCachedDocBody("d-7");
    expect(body).not.toBeNull();
    expect(body!.scope).toBe("brain");
  });
});

// ---------------------------------------------------------------------------
// Invariant 9 — no-endpoint scopes
// ---------------------------------------------------------------------------

describe("backfillDocBodies — no endpoint", () => {
  it("emits skipped with reason=no_endpoint for knowledge", async () => {
    const fetcher = jest.fn();
    const events: AnalyticsEvent[] = [];
    const summary = await backfillDocBodies(
      "knowledge",
      [{ id: "k-1" }, { id: "k-2" }],
      {
        fetcher: fetcher as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      },
    );
    expect(summary.attempted).toBe(2);
    expect(summary.skipped).toBe(2);
    expect(fetcher).not.toHaveBeenCalled();
    const skipped = events.filter(
      ([e, m]) =>
        e === "rag.doc_backfill_skipped" && m.reason === "no_endpoint",
    );
    expect(skipped).toHaveLength(2);
  });

  it("emits skipped with reason=no_endpoint for assistant", async () => {
    const fetcher = jest.fn();
    const events: AnalyticsEvent[] = [];
    await backfillDocBodies(
      "assistant",
      [{ id: "a-1" }],
      {
        fetcher: fetcher as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      },
    );
    expect(fetcher).not.toHaveBeenCalled();
    expect(
      events.some(
        ([e, m]) =>
          e === "rag.doc_backfill_skipped" && m.reason === "no_endpoint",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Invariant 10+11 — analytics completeness
// ---------------------------------------------------------------------------

describe("backfillDocBodies — analytics", () => {
  it("fires scheduled + backfilled + completed in order", async () => {
    const fetcher = jest.fn((url: string) => {
      const match = /documents\/(d-\d+)/.exec(url);
      const id = match ? match[1] : "x";
      return Promise.resolve(brainDocResponse(id, ["body"]));
    });
    const events: AnalyticsEvent[] = [];
    const summary = await backfillDocBodies(
      "brain",
      [{ id: "d-1" }, { id: "d-2" }],
      {
        fetcher: fetcher as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      },
    );
    const names = events.map(([e]) => e);
    expect(names[0]).toBe("rag.doc_backfill_scheduled");
    expect(names).toContain("rag.doc_backfilled");
    expect(names[names.length - 1]).toBe("rag.doc_backfill_completed");
    expect(summary.cached).toBe(2);
    const scheduled = events.find(
      ([e]) => e === "rag.doc_backfill_scheduled",
    );
    expect(scheduled![1]).toEqual(
      expect.objectContaining({ scope: "brain", source_count: 2, top_k: 2 }),
    );
    const doneEvent = events.find(
      ([e]) => e === "rag.doc_backfill_completed",
    );
    expect(doneEvent![1].cached).toBe(2);
    expect(doneEvent![1].attempted).toBe(2);
  });

  it("backfilled event carries bytes metadata", async () => {
    const fetcher = jest.fn(() =>
      Promise.resolve(brainDocResponse("d-1", ["abcdef"])),
    );
    const events: AnalyticsEvent[] = [];
    await backfillDocBodies(
      "brain",
      [{ id: "d-1" }],
      {
        fetcher: fetcher as unknown as typeof fetch,
        onAnalytics: (e, m) => events.push([e, m]),
      },
    );
    const backfilled = events.find(([e]) => e === "rag.doc_backfilled");
    expect(backfilled).toBeDefined();
    expect(backfilled![1].bytes).toBe(6);
    expect(backfilled![1].doc_id).toBe("d-1");
  });

  it("progress callback receives (done, total) increments", async () => {
    const fetcher = jest.fn((url: string) => {
      const match = /documents\/(d-\d+)/.exec(url);
      const id = match ? match[1] : "x";
      return Promise.resolve(brainDocResponse(id, ["b"]));
    });
    const progress: Array<[number, number]> = [];
    await backfillDocBodies(
      "brain",
      [{ id: "d-1" }, { id: "d-2" }, { id: "d-3" }],
      {
        fetcher: fetcher as unknown as typeof fetch,
        onProgress: (done, total) => progress.push([done, total]),
      },
    );
    expect(progress[progress.length - 1]).toEqual([3, 3]);
  });
});

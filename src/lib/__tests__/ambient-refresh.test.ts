/**
 * @jest-environment jsdom
 *
 * ambient-refresh — Stream U6.
 *
 * Covers:
 *   1. runSessionWarmPass iterates all scopes, respects topN.
 *   2. Wrappers invoked with forceRefresh=true (proved via test wrappers).
 *   3. Per-request delay is respected (spy on timers).
 *   4. Abort mid-pass stops remaining refreshes.
 *   5. Wrapper throws (offline) → counted as failed, continues gracefully.
 *   6. startIdleRefresh fires after idleThresholdMs.
 *   7. Any user event resets the idle timer.
 *   8. maxRefreshesPerIdleSession caps repeated firings.
 *   9. visibility=hidden pauses, visible resumes with fresh window.
 *  10. saveData=true disables idle refresh entirely + emits skipped event.
 *  11. offline during idle emits skipped{reason:"offline"} and reschedules.
 *  12. No stale entries → skipped{reason:"no_stale_entries"}, reschedules.
 *  13. _findStalestEntry picks the oldest across scopes.
 */

import "fake-indexeddb/auto";
import {
  runSessionWarmPass,
  startIdleRefresh,
  _findStalestEntry,
  _resetAmbientRefreshForTests,
  type AmbientScope,
} from "@/lib/ambient-refresh";
import {
  cacheRagResult,
  type CachedRagResult,
} from "@/lib/rag-offline";
import {
  clearAllResources,
  __resetForTests as resetCache,
} from "@/lib/offline-cache";

type AnalyticsEvent = [string, Record<string, string | number | boolean>];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function mkEntry(
  scope: string,
  query: string,
  ageMs: number,
): CachedRagResult<unknown> {
  return {
    query,
    query_fingerprint: query,
    query_tokens: query.split(" "),
    retrieved_docs: [],
    answer: "a",
    sources: [],
    scope,
    cached_at: Date.now() - ageMs,
  };
}

beforeEach(async () => {
  resetCache();
  await clearAllResources();
  _resetAmbientRefreshForTests();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
  // Reset navigator.onLine to true by default.
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

afterEach(async () => {
  await clearAllResources();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// runSessionWarmPass
// ---------------------------------------------------------------------------

describe("runSessionWarmPass", () => {
  it("re-queries the top N most-recent entries per scope, forceRefresh via wrapper", async () => {
    const events: AnalyticsEvent[] = [];
    // Seed 3 assistant entries (newest-first by cached_at).
    await cacheRagResult("assistant", {
      query: "oldest",
      retrieved_docs: [],
      answer: "a",
      sources: [],
      scope: "assistant",
    });
    await sleep(5);
    await cacheRagResult("assistant", {
      query: "middle",
      retrieved_docs: [],
      answer: "a",
      sources: [],
      scope: "assistant",
    });
    await sleep(5);
    await cacheRagResult("assistant", {
      query: "newest",
      retrieved_docs: [],
      answer: "a",
      sources: [],
      scope: "assistant",
    });

    const calls: Record<AmbientScope, string[]> = {
      assistant: [],
      knowledge: [],
      brain: [],
    };
    const wrappers: Partial<
      Record<AmbientScope, (query: string) => Promise<unknown>>
    > = {
      assistant: async (q) => {
        calls.assistant.push(q);
        return {};
      },
      knowledge: async (q) => {
        calls.knowledge.push(q);
        return {};
      },
      brain: async (q) => {
        calls.brain.push(q);
        return {};
      },
    };

    const results = await runSessionWarmPass({
      topN: 2,
      perRequestDelayMs: 0,
      wrappers,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    // topN=2 → newest two assistant queries re-touched.
    expect(calls.assistant).toEqual(["newest", "middle"]);
    expect(calls.knowledge).toEqual([]);
    expect(calls.brain).toEqual([]);

    const assistantResult = results.find((r) => r.scope === "assistant")!;
    expect(assistantResult.attempted).toBe(2);
    expect(assistantResult.refreshed).toBe(2);
    expect(assistantResult.failed).toBe(0);

    // All three scopes emit a completed event.
    const completed = events.filter(
      ([e]) => e === "ambient.warm_pass_completed",
    );
    expect(completed).toHaveLength(3);
    expect(events[0][0]).toBe("ambient.warm_pass_started");
    expect(events[0][1]).toEqual({ scope_count: 3 });
  });

  it("respects perRequestDelayMs between consecutive refreshes", async () => {
    jest.useFakeTimers();
    try {
      await cacheRagResult("assistant", {
        query: "q1",
        retrieved_docs: [],
        answer: "a",
        sources: [],
        scope: "assistant",
      });
      await cacheRagResult("assistant", {
        query: "q2",
        retrieved_docs: [],
        answer: "a",
        sources: [],
        scope: "assistant",
      });
      const wrappers = {
        assistant: jest.fn().mockResolvedValue({}),
        knowledge: jest.fn().mockResolvedValue({}),
        brain: jest.fn().mockResolvedValue({}),
      };

      const pass = runSessionWarmPass({
        topN: 2,
        perRequestDelayMs: 1000,
        wrappers,
        onAnalytics: () => {},
      });

      // Let microtasks settle — the first call fires immediately.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(wrappers.assistant).toHaveBeenCalledTimes(1);

      // Advance 999ms — still only 1 call.
      await jest.advanceTimersByTimeAsync(999);
      expect(wrappers.assistant).toHaveBeenCalledTimes(1);

      // Cross the 1000ms threshold → second call.
      await jest.advanceTimersByTimeAsync(10);
      expect(wrappers.assistant).toHaveBeenCalledTimes(2);

      await jest.runAllTimersAsync();
      await pass;
    } finally {
      jest.useRealTimers();
    }
  });

  it("stops remaining refreshes when signal aborts mid-pass", async () => {
    await cacheRagResult("assistant", {
      query: "q1",
      retrieved_docs: [],
      answer: "a",
      sources: [],
      scope: "assistant",
    });
    await cacheRagResult("assistant", {
      query: "q2",
      retrieved_docs: [],
      answer: "a",
      sources: [],
      scope: "assistant",
    });
    await cacheRagResult("assistant", {
      query: "q3",
      retrieved_docs: [],
      answer: "a",
      sources: [],
      scope: "assistant",
    });
    const controller = new AbortController();
    const wrappers = {
      assistant: jest.fn().mockImplementation(async () => {
        // Abort after the first call resolves.
        controller.abort();
        return {};
      }),
      knowledge: jest.fn().mockResolvedValue({}),
      brain: jest.fn().mockResolvedValue({}),
    };

    const results = await runSessionWarmPass({
      topN: 10,
      perRequestDelayMs: 5,
      wrappers,
      signal: controller.signal,
      onAnalytics: () => {},
    });

    // Exactly one call — the abort cleared the sleep before call 2.
    expect(wrappers.assistant).toHaveBeenCalledTimes(1);
    expect(wrappers.knowledge).not.toHaveBeenCalled();
    expect(wrappers.brain).not.toHaveBeenCalled();
    // We still return a full per-scope result shape.
    expect(results).toHaveLength(3);
  });

  it("counts wrapper failures (e.g. offline mid-pass) as failed, continues", async () => {
    await cacheRagResult("assistant", {
      query: "q1",
      retrieved_docs: [],
      answer: "a",
      sources: [],
      scope: "assistant",
    });
    await cacheRagResult("assistant", {
      query: "q2",
      retrieved_docs: [],
      answer: "a",
      sources: [],
      scope: "assistant",
    });
    const wrappers = {
      assistant: jest
        .fn()
        .mockRejectedValueOnce(new Error("RagOfflineMissError"))
        .mockResolvedValueOnce({}),
      knowledge: jest.fn().mockResolvedValue({}),
      brain: jest.fn().mockResolvedValue({}),
    };

    const results = await runSessionWarmPass({
      topN: 2,
      perRequestDelayMs: 0,
      wrappers,
      onAnalytics: () => {},
    });

    const assistantResult = results.find((r) => r.scope === "assistant")!;
    expect(assistantResult.attempted).toBe(2);
    expect(assistantResult.refreshed).toBe(1);
    expect(assistantResult.failed).toBe(1);
  });

  it("empty cache produces zero-count completed events with no wrapper calls", async () => {
    const wrappers = {
      assistant: jest.fn().mockResolvedValue({}),
      knowledge: jest.fn().mockResolvedValue({}),
      brain: jest.fn().mockResolvedValue({}),
    };
    const events: AnalyticsEvent[] = [];
    const results = await runSessionWarmPass({
      topN: 10,
      perRequestDelayMs: 0,
      wrappers,
      onAnalytics: (e, m) => events.push([e, m]),
    });
    expect(wrappers.assistant).not.toHaveBeenCalled();
    expect(wrappers.knowledge).not.toHaveBeenCalled();
    expect(wrappers.brain).not.toHaveBeenCalled();
    for (const r of results) {
      expect(r.attempted).toBe(0);
      expect(r.refreshed).toBe(0);
      expect(r.failed).toBe(0);
    }
    expect(events.filter(([e]) => e === "ambient.warm_pass_completed")).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// _findStalestEntry
// ---------------------------------------------------------------------------

describe("_findStalestEntry", () => {
  it("returns the oldest entry across scopes older than threshold", async () => {
    const fakeLister = async (scope: string) => {
      if (scope === "assistant")
        return [mkEntry("assistant", "asst-old", 26 * 60 * 60 * 1000)];
      if (scope === "knowledge")
        return [
          mkEntry("knowledge", "know-older", 40 * 60 * 60 * 1000),
          mkEntry("knowledge", "know-fresh", 5 * 60 * 1000),
        ];
      if (scope === "brain")
        return [mkEntry("brain", "brain-mid", 30 * 60 * 60 * 1000)];
      return [];
    };

    const stalest = await _findStalestEntry(
      ["assistant", "knowledge", "brain"],
      24 * 60 * 60 * 1000,
      fakeLister,
    );
    expect(stalest).not.toBeNull();
    expect(stalest!.scope).toBe("knowledge");
    expect(stalest!.query).toBe("know-older");
  });

  it("returns null when nothing is stale enough", async () => {
    const fakeLister = async () => [
      mkEntry("assistant", "fresh", 60 * 1000),
    ];
    const stalest = await _findStalestEntry(
      ["assistant"],
      24 * 60 * 60 * 1000,
      fakeLister,
    );
    expect(stalest).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// startIdleRefresh
// ---------------------------------------------------------------------------

describe("startIdleRefresh", () => {
  function setSaveData(value: boolean) {
    Object.defineProperty(window.navigator, "connection", {
      configurable: true,
      value: { saveData: value },
    });
  }

  function setVisibility(state: "visible" | "hidden") {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    });
    document.dispatchEvent(new Event("visibilitychange"));
  }

  afterEach(() => {
    // Reset navigator.connection so other tests aren't poisoned.
    Object.defineProperty(window.navigator, "connection", {
      configurable: true,
      value: undefined,
    });
    setVisibility("visible");
  });

  it("fires a refresh on the stalest entry after idleThresholdMs", async () => {
    jest.useFakeTimers();
    try {
      const events: AnalyticsEvent[] = [];
      const wrapper = jest.fn().mockResolvedValue({});
      const lister = async (scope: string) => {
        if (scope === "assistant")
          return [mkEntry("assistant", "stale-q", 48 * 60 * 60 * 1000)];
        return [];
      };

      const handle = startIdleRefresh({
        idleThresholdMs: 100,
        staleThresholdMs: 24 * 60 * 60 * 1000,
        wrappers: { assistant: wrapper },
        lister,
        isOnline: () => true,
        isSaveData: () => false,
        onAnalytics: (e, m) => events.push([e, m]),
      });

      await jest.advanceTimersByTimeAsync(100);
      // Drain microtasks for the async onIdleTick body.
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(wrapper).toHaveBeenCalledWith("stale-q");
      expect(events.map((e) => e[0])).toContain("ambient.idle_detected");
      expect(events.map((e) => e[0])).toContain("ambient.idle_refresh_fired");

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("any user event resets the idle timer", async () => {
    jest.useFakeTimers();
    try {
      const wrapper = jest.fn().mockResolvedValue({});
      const lister = async (scope: string) =>
        scope === "assistant"
          ? [mkEntry("assistant", "stale-q", 48 * 60 * 60 * 1000)]
          : [];

      const handle = startIdleRefresh({
        idleThresholdMs: 100,
        wrappers: { assistant: wrapper },
        lister,
        isOnline: () => true,
        isSaveData: () => false,
        onAnalytics: () => {},
      });

      // Advance 50ms, then generate activity → timer resets.
      await jest.advanceTimersByTimeAsync(50);
      document.dispatchEvent(new Event("click"));
      // Advance another 50ms — still below threshold since reset.
      await jest.advanceTimersByTimeAsync(50);
      expect(wrapper).not.toHaveBeenCalled();

      // Now go idle for a full 100ms.
      await jest.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(wrapper).toHaveBeenCalledTimes(1);

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("respects maxRefreshesPerIdleSession", async () => {
    jest.useFakeTimers();
    try {
      const events: AnalyticsEvent[] = [];
      const wrapper = jest.fn().mockResolvedValue({});
      // Keep returning a stale entry every time so the cap is what stops us.
      const lister = async (scope: string) =>
        scope === "assistant"
          ? [mkEntry("assistant", "stale-q", 48 * 60 * 60 * 1000)]
          : [];

      const handle = startIdleRefresh({
        idleThresholdMs: 100,
        maxRefreshesPerIdleSession: 2,
        wrappers: { assistant: wrapper },
        lister,
        isOnline: () => true,
        isSaveData: () => false,
        onAnalytics: (e, m) => events.push([e, m]),
      });

      // Tick 1 → fire 1.
      await jest.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Tick 2 → fire 2.
      await jest.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      // Tick 3 → skipped due to cap.
      await jest.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      expect(wrapper).toHaveBeenCalledTimes(2);
      const skipped = events.filter(
        ([e, m]) =>
          e === "ambient.idle_refresh_skipped" &&
          m.reason === "max_refreshes_reached",
      );
      expect(skipped.length).toBeGreaterThanOrEqual(1);

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("saveData=true disables the watcher and emits a skipped event", async () => {
    const events: AnalyticsEvent[] = [];
    const wrapper = jest.fn().mockResolvedValue({});
    const handle = startIdleRefresh({
      idleThresholdMs: 10,
      wrappers: { assistant: wrapper },
      lister: async (scope) =>
        scope === "assistant"
          ? [mkEntry("assistant", "stale-q", 48 * 60 * 60 * 1000)]
          : [],
      isOnline: () => true,
      isSaveData: () => true,
      onAnalytics: (e, m) => events.push([e, m]),
    });

    await sleep(30);
    expect(wrapper).not.toHaveBeenCalled();
    const skipped = events.find(
      ([e, m]) =>
        e === "ambient.idle_refresh_skipped" && m.reason === "save_data",
    );
    expect(skipped).toBeDefined();

    handle.stop();
  });

  it("visibility=hidden pauses and visible resumes", async () => {
    jest.useFakeTimers();
    try {
      const wrapper = jest.fn().mockResolvedValue({});
      const lister = async (scope: string) =>
        scope === "assistant"
          ? [mkEntry("assistant", "stale-q", 48 * 60 * 60 * 1000)]
          : [];

      const handle = startIdleRefresh({
        idleThresholdMs: 100,
        wrappers: { assistant: wrapper },
        lister,
        isOnline: () => true,
        isSaveData: () => false,
        onAnalytics: () => {},
      });

      // Hide before threshold → no fire.
      await jest.advanceTimersByTimeAsync(50);
      setVisibility("hidden");
      await jest.advanceTimersByTimeAsync(200);
      expect(wrapper).not.toHaveBeenCalled();

      // Restore visibility → fresh idle window, then fire.
      setVisibility("visible");
      await jest.advanceTimersByTimeAsync(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      expect(wrapper).toHaveBeenCalledTimes(1);

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("offline during idle emits skipped{offline} and reschedules", async () => {
    jest.useFakeTimers();
    try {
      const events: AnalyticsEvent[] = [];
      const wrapper = jest.fn().mockResolvedValue({});
      const handle = startIdleRefresh({
        idleThresholdMs: 50,
        wrappers: { assistant: wrapper },
        lister: async (scope) =>
          scope === "assistant"
            ? [mkEntry("assistant", "q", 48 * 60 * 60 * 1000)]
            : [],
        isOnline: () => false,
        isSaveData: () => false,
        onAnalytics: (e, m) => events.push([e, m]),
      });

      await jest.advanceTimersByTimeAsync(50);
      await Promise.resolve();
      expect(wrapper).not.toHaveBeenCalled();
      const skipped = events.find(
        ([e, m]) =>
          e === "ambient.idle_refresh_skipped" && m.reason === "offline",
      );
      expect(skipped).toBeDefined();

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("no stale entries emits skipped{no_stale_entries} and reschedules", async () => {
    jest.useFakeTimers();
    try {
      const events: AnalyticsEvent[] = [];
      const wrapper = jest.fn().mockResolvedValue({});
      const handle = startIdleRefresh({
        idleThresholdMs: 50,
        staleThresholdMs: 24 * 60 * 60 * 1000,
        wrappers: { assistant: wrapper },
        lister: async (scope) =>
          scope === "assistant"
            ? [mkEntry("assistant", "fresh", 60 * 1000)]
            : [],
        isOnline: () => true,
        isSaveData: () => false,
        onAnalytics: (e, m) => events.push([e, m]),
      });

      await jest.advanceTimersByTimeAsync(50);
      await Promise.resolve();
      await Promise.resolve();
      expect(wrapper).not.toHaveBeenCalled();
      const skipped = events.find(
        ([e, m]) =>
          e === "ambient.idle_refresh_skipped" &&
          m.reason === "no_stale_entries",
      );
      expect(skipped).toBeDefined();

      handle.stop();
    } finally {
      jest.useRealTimers();
    }
  });

  it("stop() removes all listeners and clears timers", async () => {
    jest.useFakeTimers();
    try {
      const wrapper = jest.fn().mockResolvedValue({});
      const handle = startIdleRefresh({
        idleThresholdMs: 100,
        wrappers: { assistant: wrapper },
        lister: async (scope) =>
          scope === "assistant"
            ? [mkEntry("assistant", "q", 48 * 60 * 60 * 1000)]
            : [],
        isOnline: () => true,
        isSaveData: () => false,
        onAnalytics: () => {},
      });

      handle.stop();
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(wrapper).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it("abort signal cancels the watcher", async () => {
    jest.useFakeTimers();
    try {
      const controller = new AbortController();
      const wrapper = jest.fn().mockResolvedValue({});
      startIdleRefresh({
        idleThresholdMs: 100,
        wrappers: { assistant: wrapper },
        lister: async (scope) =>
          scope === "assistant"
            ? [mkEntry("assistant", "q", 48 * 60 * 60 * 1000)]
            : [],
        isOnline: () => true,
        isSaveData: () => false,
        onAnalytics: () => {},
        signal: controller.signal,
      });

      controller.abort();
      await jest.advanceTimersByTimeAsync(500);
      await Promise.resolve();
      expect(wrapper).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });
});

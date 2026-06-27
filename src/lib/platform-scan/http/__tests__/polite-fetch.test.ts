/**
 * Politeness layer tests (safety-critical: this is the code that keeps a scan
 * from knocking over a client's prod system). Everything is deterministic - a
 * fake clock + fake sleep + injected fetch mean NO real timers and NO network,
 * so the suite is fast and the concurrency/pacing/backoff invariants are proven
 * exactly, not flakily.
 */
import {
  PoliteFetcher,
  politeFetch,
  parseRetryAfterMs,
  computeBackoffMs,
  hostOf,
  DEFAULT_PER_HOST_CONCURRENCY,
} from "../polite-fetch";

/** A controllable fake clock + sleep. sleep() advances the clock and resolves
 *  on the next microtask, so awaited backoffs are instant + deterministic. */
function fakeTime(start = 0) {
  let t = start;
  return {
    now: () => t,
    sleep: async (ms: number) => {
      t += ms;
    },
    advance: (ms: number) => {
      t += ms;
    },
    get current() {
      return t;
    },
  };
}

function res(status: number, headers: Record<string, string> = {}): Response {
  return { status, headers: new Headers(headers) } as unknown as Response;
}

describe("hostOf", () => {
  it("extracts the host (incl. port) from a URL", () => {
    expect(hostOf("https://demo.example.com/admin/leads")).toBe("demo.example.com");
    expect(hostOf("http://localhost:3000/a")).toBe("localhost:3000");
  });
  it("falls back to the raw string for an unparseable URL (consistent bucket)", () => {
    expect(hostOf("not a url")).toBe("not a url");
  });
});

describe("parseRetryAfterMs", () => {
  const now = () => 1_000_000;
  it("parses delta-seconds form", () => {
    expect(parseRetryAfterMs("5", now)).toBe(5000);
    expect(parseRetryAfterMs("0", now)).toBe(0);
  });
  it("parses HTTP-date form relative to the injected clock", () => {
    const future = new Date(1_000_000 + 3000).toUTCString();
    // toUTCString truncates to whole seconds, so allow a sub-second slack.
    const got = parseRetryAfterMs(future, now)!;
    expect(got).toBeGreaterThanOrEqual(2000);
    expect(got).toBeLessThanOrEqual(3000);
  });
  it("clamps a past HTTP-date to 0", () => {
    const past = new Date(1_000_000 - 5000).toUTCString();
    expect(parseRetryAfterMs(past, now)).toBe(0);
  });
  it("returns null for absent / empty / garbage", () => {
    expect(parseRetryAfterMs(null, now)).toBeNull();
    expect(parseRetryAfterMs(undefined, now)).toBeNull();
    expect(parseRetryAfterMs("", now)).toBeNull();
    expect(parseRetryAfterMs("soon", now)).toBeNull();
  });
});

describe("computeBackoffMs", () => {
  it("prefers Retry-After when present (clamped to ceiling)", () => {
    expect(computeBackoffMs(1, 4000, { baseBackoffMs: 500, maxBackoffMs: 30000 })).toBe(4000);
    expect(computeBackoffMs(1, 999_999, { baseBackoffMs: 500, maxBackoffMs: 30000 })).toBe(30000);
  });
  it("uses exponential-with-jitter when no Retry-After (grows with attempt)", () => {
    // rand fixed to 1 => full exponential value: base * 2^(attempt-1).
    const rand = () => 1;
    expect(computeBackoffMs(1, null, { baseBackoffMs: 500, maxBackoffMs: 30000, rand })).toBe(500);
    expect(computeBackoffMs(2, null, { baseBackoffMs: 500, maxBackoffMs: 30000, rand })).toBe(1000);
    expect(computeBackoffMs(3, null, { baseBackoffMs: 500, maxBackoffMs: 30000, rand })).toBe(2000);
  });
  it("jitter scales the wait down (rand 0.5 => half)", () => {
    expect(computeBackoffMs(3, null, { baseBackoffMs: 500, maxBackoffMs: 30000, rand: () => 0.5 })).toBe(1000);
  });
});

describe("PoliteFetcher concurrency", () => {
  it("never exceeds the per-host cap under a burst of N > cap requests", async () => {
    const clk = fakeTime();
    let inFlight = 0;
    let maxInFlight = 0;
    // A gated fetch: each call parks until we release it, so we can observe how
    // many run at once.
    const releases: Array<() => void> = [];
    const fetchImpl = jest.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => releases.push(() => r()));
      inFlight -= 1;
      return res(200);
    }) as unknown as typeof fetch;

    const fetcher = new PoliteFetcher({
      fetchImpl,
      perHostConcurrency: 4,
      minGapMs: 0,
      now: clk.now,
      sleep: clk.sleep,
    });

    const N = 20;
    const all = Promise.all(
      Array.from({ length: N }, (_, i) => fetcher.fetch(`https://h.example/${i}`)),
    );

    // Drain in waves: release whatever is parked, let the queue refill, repeat,
    // until all N fetches have been invoked AND drained. At no point may more
    // than 4 be in flight (the cap). Flush microtasks generously each wave so a
    // freed slot has time to acquire + re-park before the next release.
    for (let guard = 0; guard < 200 && (fetchImpl as jest.Mock).mock.calls.length < N; guard++) {
      const batch = releases.splice(0, releases.length);
      batch.forEach((r) => r());
      for (let f = 0; f < 6; f++) await Promise.resolve();
    }
    // Release any still-parked final wave so the run completes.
    releases.splice(0).forEach((r) => r());
    await all;

    expect(maxInFlight).toBeLessThanOrEqual(4);
    expect(fetchImpl).toHaveBeenCalledTimes(N);
  });

  it("runs requests to DIFFERENT hosts in parallel (cap is per host)", async () => {
    const clk = fakeTime();
    let inFlight = 0;
    let maxInFlight = 0;
    const releases: Array<() => void> = [];
    const fetchImpl = jest.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise<void>((r) => releases.push(() => r()));
      inFlight -= 1;
      return res(200);
    }) as unknown as typeof fetch;

    const fetcher = new PoliteFetcher({
      fetchImpl,
      perHostConcurrency: 1, // 1 per host
      minGapMs: 0,
      now: clk.now,
      sleep: clk.sleep,
    });

    // 5 distinct hosts, 1 request each => all 5 may run at once despite cap=1/host.
    const all = Promise.all([
      fetcher.fetch("https://a.example/x"),
      fetcher.fetch("https://b.example/x"),
      fetcher.fetch("https://c.example/x"),
      fetcher.fetch("https://d.example/x"),
      fetcher.fetch("https://e.example/x"),
    ]);
    await Promise.resolve();
    await Promise.resolve();
    expect(maxInFlight).toBe(5);
    releases.splice(0).forEach((r) => r());
    await all;
  });
});

describe("PoliteFetcher pacing", () => {
  it("enforces the minimum gap between requests to the same host", async () => {
    const clk = fakeTime(0);
    const starts: number[] = [];
    const fetchImpl = jest.fn(async () => {
      starts.push(clk.current);
      return res(200);
    }) as unknown as typeof fetch;

    const fetcher = new PoliteFetcher({
      fetchImpl,
      perHostConcurrency: 1, // serialize so pacing is observable in order
      minGapMs: 200,
      now: clk.now,
      sleep: clk.sleep,
    });

    await fetcher.fetch("https://h.example/1");
    await fetcher.fetch("https://h.example/2");
    await fetcher.fetch("https://h.example/3");

    // First fires immediately; each subsequent waits >= 200ms after the prior.
    expect(starts[0]).toBe(0);
    expect(starts[1] - starts[0]).toBeGreaterThanOrEqual(200);
    expect(starts[2] - starts[1]).toBeGreaterThanOrEqual(200);
  });
});

describe("PoliteFetcher backoff + retry", () => {
  it("429 with Retry-After seconds: waits that long, then retries, returns the eventual 200", async () => {
    const clk = fakeTime(0);
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      if (call === 1) return res(429, { "retry-after": "7" });
      return res(200);
    }) as unknown as typeof fetch;

    const onThrottle = jest.fn();
    const fetcher = new PoliteFetcher({
      fetchImpl,
      minGapMs: 0,
      now: clk.now,
      sleep: clk.sleep,
      onThrottle,
    });

    const r = await fetcher.fetch("https://h.example/a");
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    // It waited the Retry-After (7s) before retrying.
    expect(clk.current).toBeGreaterThanOrEqual(7000);
    expect(onThrottle).toHaveBeenCalledTimes(1);
    expect(onThrottle).toHaveBeenCalledWith(
      expect.objectContaining({ host: "h.example", retryAfterMs: 7000, reason: "429", attempt: 1 }),
    );
  });

  it("503 backs off (exponential when no Retry-After) then succeeds", async () => {
    const clk = fakeTime(0);
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      return call === 1 ? res(503) : res(200);
    }) as unknown as typeof fetch;

    const onThrottle = jest.fn();
    const fetcher = new PoliteFetcher({
      fetchImpl,
      minGapMs: 0,
      baseBackoffMs: 500,
      now: clk.now,
      sleep: clk.sleep,
      onThrottle,
    });

    const r = await fetcher.fetch("https://h.example/a");
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(onThrottle).toHaveBeenCalledWith(expect.objectContaining({ reason: "503", attempt: 1 }));
    expect(clk.current).toBeGreaterThan(0); // some backoff happened
  });

  it("exceeds max retries: returns the LAST throttling response, no infinite loop", async () => {
    const clk = fakeTime(0);
    const fetchImpl = jest.fn(async () => res(429, { "retry-after": "1" })) as unknown as typeof fetch;
    const onThrottle = jest.fn();
    const fetcher = new PoliteFetcher({
      fetchImpl,
      minGapMs: 0,
      maxRetries: 2,
      now: clk.now,
      sleep: clk.sleep,
      onThrottle,
    });

    const r = await fetcher.fetch("https://h.example/a");
    // Initial attempt + 2 retries = 3 fetches, then it gives up and returns the 429
    // so the engine still flags it as a finding (behavior preserved).
    expect(r.status).toBe(429);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(onThrottle).toHaveBeenCalledTimes(2);
  });

  it("caps a hostile Retry-After at maxBackoffMs (never parks for hours)", async () => {
    const clk = fakeTime(0);
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      return call === 1 ? res(429, { "retry-after": "86400" }) : res(200);
    }) as unknown as typeof fetch;
    const fetcher = new PoliteFetcher({
      fetchImpl,
      minGapMs: 0,
      maxBackoffMs: 30000,
      now: clk.now,
      sleep: clk.sleep,
    });
    const r = await fetcher.fetch("https://h.example/a");
    expect(r.status).toBe(200);
    expect(clk.current).toBe(30000); // clamped, not 86_400_000
  });

  it("a non-retryable non-2xx (404/500) is returned immediately, never retried", async () => {
    const clk = fakeTime(0);
    const fetch404 = jest.fn(async () => res(404)) as unknown as typeof fetch;
    const f = new PoliteFetcher({ fetchImpl: fetch404, minGapMs: 0, now: clk.now, sleep: clk.sleep });
    expect((await f.fetch("https://h.example/x")).status).toBe(404);
    expect(fetch404).toHaveBeenCalledTimes(1);
  });

  it("a transport throw propagates (engine records it as a networkError)", async () => {
    const clk = fakeTime(0);
    const boom = jest.fn(async () => {
      throw new Error("ECONNRESET");
    }) as unknown as typeof fetch;
    const f = new PoliteFetcher({ fetchImpl: boom, minGapMs: 0, now: clk.now, sleep: clk.sleep });
    await expect(f.fetch("https://h.example/x")).rejects.toThrow("ECONNRESET");
  });

  it("onThrottle that throws never breaks the scan", async () => {
    const clk = fakeTime(0);
    let call = 0;
    const fetchImpl = jest.fn(async () => {
      call += 1;
      return call === 1 ? res(503) : res(200);
    }) as unknown as typeof fetch;
    const f = new PoliteFetcher({
      fetchImpl,
      minGapMs: 0,
      now: clk.now,
      sleep: clk.sleep,
      onThrottle: () => {
        throw new Error("analytics down");
      },
    });
    expect((await f.fetch("https://h.example/x")).status).toBe(200);
  });
});

describe("politeFetch convenience wrapper", () => {
  it("delegates to a one-off PoliteFetcher", async () => {
    const clk = fakeTime(0);
    const fetchImpl = jest.fn(async () => res(200)) as unknown as typeof fetch;
    const r = await politeFetch("https://h.example/x", undefined, {
      fetchImpl,
      minGapMs: 0,
      now: clk.now,
      sleep: clk.sleep,
    });
    expect(r.status).toBe(200);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("defaults", () => {
  it("exposes a gentle default per-host concurrency", () => {
    expect(DEFAULT_PER_HOST_CONCURRENCY).toBeLessThanOrEqual(8);
    expect(DEFAULT_PER_HOST_CONCURRENCY).toBeGreaterThanOrEqual(1);
  });
});

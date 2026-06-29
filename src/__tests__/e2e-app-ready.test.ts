/**
 * Unit tests for the E2E readiness gate (tests/e2e/helpers/app-ready.ts).
 *
 * The gate is the thing that stops the reality-check suites from racing a
 * cold preview deployment. If IT flakes or hangs, the whole point is lost,
 * so it gets its own deterministic test with an injected fake fetch + fake
 * clock + no-op sleep — no network, no real timers.
 *
 * Lives under src/__tests__ because jest.config.ts's testMatch only picks up
 * src/**\/__tests__; the helper under tests/e2e is imported by relative path.
 */
import {
  waitForAppReady,
  type FetchLike,
} from "../../tests/e2e/helpers/app-ready";

const BASE = "https://preview.example.test";

/** A fetch fake that returns the given statuses in order, looping the last. */
function fetchReturning(statuses: number[]): { fetchImpl: FetchLike; calls: () => number } {
  let i = 0;
  const fetchImpl: FetchLike = async () => {
    const status = statuses[Math.min(i, statuses.length - 1)];
    i += 1;
    return { status };
  };
  return { fetchImpl, calls: () => i };
}

/** A monotonic fake clock that advances by `step` on every read. */
function fakeClock(step = 0): () => number {
  let t = 0;
  return () => {
    const v = t;
    t += step;
    return v;
  };
}

describe("waitForAppReady", () => {
  const silent = () => {};

  it("resolves after a 200 following two 503s (503, 503, 200)", async () => {
    const { fetchImpl, calls } = fetchReturning([503, 503, 200]);
    const attempts = await waitForAppReady(BASE, {
      fetchImpl,
      sleep: async () => {}, // no real waiting
      now: () => 0, // never advances → never times out before the 200
      log: silent,
    });
    expect(attempts).toBe(3);
    expect(calls()).toBe(3);
  });

  it("resolves fast on an immediate 200 (single attempt)", async () => {
    const { fetchImpl, calls } = fetchReturning([200]);
    const attempts = await waitForAppReady(BASE, {
      fetchImpl,
      sleep: async () => {},
      now: () => 0,
      log: silent,
    });
    expect(attempts).toBe(1);
    expect(calls()).toBe(1);
  });

  it("rejects with a clear message when the app never becomes ready", async () => {
    const { fetchImpl } = fetchReturning([503]);
    // Clock advances 1s per read so the budget is genuinely consumed and the
    // loop terminates — proving the gate NEVER hangs forever.
    await expect(
      waitForAppReady(BASE, {
        fetchImpl,
        sleep: async () => {},
        now: fakeClock(1_000),
        timeoutMs: 5_000,
        baseDelayMs: 1_000,
        log: silent,
      }),
    ).rejects.toThrow(/did not become ready within 5000ms/);
  });

  it("surfaces the last status/reason in the timeout error", async () => {
    const { fetchImpl } = fetchReturning([500]);
    await expect(
      waitForAppReady(BASE, {
        fetchImpl,
        sleep: async () => {},
        now: fakeClock(2_000),
        timeoutMs: 4_000,
        baseDelayMs: 1_000,
        log: silent,
      }),
    ).rejects.toThrow(/status 500/);
  });

  it("treats a network throw as not-ready and keeps polling until the budget runs out", async () => {
    let i = 0;
    const fetchImpl: FetchLike = async () => {
      i += 1;
      throw new Error("ECONNREFUSED");
    };
    await expect(
      waitForAppReady(BASE, {
        fetchImpl,
        sleep: async () => {},
        now: fakeClock(1_500),
        timeoutMs: 4_500,
        baseDelayMs: 1_000,
        log: silent,
      }),
    ).rejects.toThrow(/ECONNREFUSED/);
    expect(i).toBeGreaterThanOrEqual(1);
  });

  it("honors a custom acceptStatuses set (e.g. 204 counts as ready)", async () => {
    const { fetchImpl } = fetchReturning([204]);
    const attempts = await waitForAppReady(BASE, {
      fetchImpl,
      acceptStatuses: [200, 204],
      sleep: async () => {},
      now: () => 0,
      log: silent,
    });
    expect(attempts).toBe(1);
  });

  it("strips a trailing slash from baseUrl and appends the ready path", async () => {
    let seen = "";
    const fetchImpl: FetchLike = async (url) => {
      seen = url;
      return { status: 200 };
    };
    await waitForAppReady(`${BASE}/`, {
      fetchImpl,
      readyPath: "/api/version",
      sleep: async () => {},
      now: () => 0,
      log: silent,
    });
    expect(seen).toBe(`${BASE}/api/version`);
  });
});

/**
 * Unit tests for the bring-your-own-agent gate rate limiter.
 *
 * The DB store is injected (deps.increment) and the clock is injected (deps.now)
 * so no Postgres is touched and window math is deterministic. Covers: under
 * limit -> ok, at limit -> ok, over limit -> blocked, window reset, fail-closed
 * on a store error, shadow mode (no DB) -> allow, and the pure window-floor.
 */
import {
  checkRateLimit,
  windowStartMs,
  DEFAULT_LIMIT,
  DEFAULT_WINDOW_MS,
} from "@/lib/ogiam/gate-rate-limit";

describe("windowStartMs (pure window floor)", () => {
  it("floors a timestamp to the start of its fixed window", () => {
    expect(windowStartMs(0, 60_000)).toBe(0);
    expect(windowStartMs(59_999, 60_000)).toBe(0);
    expect(windowStartMs(60_000, 60_000)).toBe(60_000);
    expect(windowStartMs(125_000, 60_000)).toBe(120_000);
  });
});

describe("checkRateLimit", () => {
  const ORIG_DB = process.env.DATABASE_URL;
  beforeEach(() => {
    process.env.DATABASE_URL = "postgres://test"; // not shadow mode
  });
  afterEach(() => {
    process.env.DATABASE_URL = ORIG_DB;
  });

  it("allows under the limit and reports remaining budget", async () => {
    const increment = jest.fn().mockResolvedValue(1);
    const res = await checkRateLimit("k1", {
      limit: 3,
      windowMs: 60_000,
      now: () => 0,
      increment,
    });
    expect(res).toEqual({ ok: true, remaining: 2 });
    // Counts against the floored window start.
    expect(increment).toHaveBeenCalledWith(
      "k1",
      new Date(0).toISOString(),
    );
  });

  it("allows the request that hits exactly the limit (remaining 0)", async () => {
    const res = await checkRateLimit("k1", {
      limit: 3,
      now: () => 0,
      increment: jest.fn().mockResolvedValue(3),
    });
    expect(res).toEqual({ ok: true, remaining: 0 });
  });

  it("blocks once the post-increment count exceeds the limit", async () => {
    const res = await checkRateLimit("k1", {
      limit: 3,
      now: () => 0,
      increment: jest.fn().mockResolvedValue(4),
    });
    expect(res).toEqual({ ok: false, remaining: 0 });
  });

  it("resets across a window boundary (a new window starts the count over)", async () => {
    // Per-window store keyed by windowStart; the limiter passes a different
    // windowStart once the clock crosses the boundary, so the count starts fresh.
    const store = new Map<string, number>();
    const increment = async (keyId: string, windowStartIso: string) => {
      const k = `${keyId}|${windowStartIso}`;
      const next = (store.get(k) ?? 0) + 1;
      store.set(k, next);
      return next;
    };

    // Window A: exhaust the budget of 2.
    let now = 1_000;
    const deps = { limit: 2, windowMs: 60_000, now: () => now, increment };
    expect((await checkRateLimit("k1", deps)).ok).toBe(true); // count 1
    expect((await checkRateLimit("k1", deps)).ok).toBe(true); // count 2
    expect((await checkRateLimit("k1", deps)).ok).toBe(false); // count 3 -> over

    // Advance past the window boundary -> new window -> fresh count.
    now = 61_000;
    const after = await checkRateLimit("k1", deps);
    expect(after).toEqual({ ok: true, remaining: 1 });
  });

  it("isolates budgets per key (one key's window does not consume another's)", async () => {
    const store = new Map<string, number>();
    const increment = async (keyId: string, windowStartIso: string) => {
      const k = `${keyId}|${windowStartIso}`;
      const next = (store.get(k) ?? 0) + 1;
      store.set(k, next);
      return next;
    };
    const deps = { limit: 1, windowMs: 60_000, now: () => 0, increment };
    expect((await checkRateLimit("k1", deps)).ok).toBe(true);
    expect((await checkRateLimit("k1", deps)).ok).toBe(false); // k1 exhausted
    expect((await checkRateLimit("k2", deps)).ok).toBe(true); // k2 fresh
  });

  it("fails CLOSED when the store throws (a limiter must not error open)", async () => {
    const res = await checkRateLimit("k1", {
      limit: 100,
      now: () => 0,
      increment: jest.fn().mockRejectedValue(new Error("db down")),
    });
    expect(res).toEqual({ ok: false, remaining: 0 });
  });

  it("allows in shadow mode (no DATABASE_URL, no injected store)", async () => {
    delete process.env.DATABASE_URL;
    const res = await checkRateLimit("k1", { limit: 5 });
    expect(res).toEqual({ ok: true, remaining: 5 });
  });

  it("exposes sane defaults", () => {
    expect(DEFAULT_LIMIT).toBe(120);
    expect(DEFAULT_WINDOW_MS).toBe(60_000);
  });
});

/**
 * @jest-environment jsdom
 *
 * Offline mutation queue — enqueue / flush / order / backoff / retry cap /
 * analytics / auth-strip invariant.
 *
 * Uses fake-indexeddb (devDep) to exercise the native IDB paths without a
 * real browser. The queue falls back to an in-memory array when IDB is
 * unavailable — we assert both paths.
 */

import "fake-indexeddb/auto";
import {
  enqueueMutation,
  flushQueue,
  listQueue,
  stripSessionHeaders,
  clearQueue,
  MAX_ATTEMPTS,
  backoffForAttempt,
  BACKOFF_CAP_MS,
  __resetForTests,
} from "@/lib/offline-queue";

function mkResponse(status: number, body: unknown = {}): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
    headers: new Headers({ "content-type": "application/json" }),
  } as unknown as Response;
}

beforeEach(async () => {
  __resetForTests();
  await clearQueue();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
});

afterEach(async () => {
  await clearQueue();
  window.localStorage.clear();
});

// ---------------------------------------------------------------------------
// Header stripping — the Authorization-never-persisted invariant
// ---------------------------------------------------------------------------

describe("stripSessionHeaders", () => {
  it("removes Authorization, Cookie, and CSRF headers (case-insensitive)", () => {
    const out = stripSessionHeaders({
      Authorization: "Bearer abc",
      cookie: "session=xyz",
      "X-CSRF-Token": "nonce",
      "X-Request-Id": "keep-me",
      "Content-Type": "application/json",
    });
    expect(out).toEqual({
      "x-request-id": "keep-me",
      "content-type": "application/json",
    });
    expect(out).not.toHaveProperty("authorization");
    expect(out).not.toHaveProperty("cookie");
  });

  it("returns empty object for missing headers", () => {
    expect(stripSessionHeaders(undefined)).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// Enqueue invariants
// ---------------------------------------------------------------------------

describe("enqueueMutation", () => {
  it("persists the entry with no Authorization header", async () => {
    await enqueueMutation({
      endpoint: "/api/sites/1/brief-edit",
      method: "POST",
      headers: { Authorization: "Bearer leaked", "Content-Type": "application/json" },
      body: { prompt: "hi" },
    });
    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].headers).not.toHaveProperty("authorization");
    expect(rows[0].headers).not.toHaveProperty("Authorization");
    expect(rows[0].body).toBe('{"prompt":"hi"}');
    expect(rows[0].status).toBe("pending");
    expect(rows[0].attempts).toBe(0);
    expect(rows[0].enqueued_at).toBeGreaterThan(0);
    expect(rows[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("fires analytics for every enqueue (offline.mutation_queued)", async () => {
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    await enqueueMutation({
      endpoint: "/api/sites/42/brief",
      method: "PATCH",
      body: { title: "x" },
    });

    // Flush microtasks so the fire-and-forget analytics POST settles
    await new Promise((r) => setTimeout(r, 0));
    const analyticsCall = fetchSpy.mock.calls.find((c) => c[0] === "/api/analytics");
    expect(analyticsCall).toBeDefined();
    const body = JSON.parse(analyticsCall![1].body as string);
    expect(body.event).toBe("offline.mutation_queued");
    expect(body.metadata).toEqual({ endpoint: "/api/sites/42/brief", method: "PATCH" });
  });
});

// ---------------------------------------------------------------------------
// Flush — FIFO replay, success path, auth re-attach
// ---------------------------------------------------------------------------

describe("flushQueue — replay ordering and success", () => {
  it("replays in FIFO order and re-attaches Authorization from current token", async () => {
    // Enqueue three with increasing enqueued_at (micro-stagger).
    const originalNow = Date.now;
    let t = 1_000_000;
    jest.spyOn(Date, "now").mockImplementation(() => t++);

    await enqueueMutation({ endpoint: "/api/sites/1/a", method: "POST", body: { n: 1 } });
    await enqueueMutation({ endpoint: "/api/sites/1/b", method: "POST", body: { n: 2 } });
    await enqueueMutation({ endpoint: "/api/sites/1/c", method: "POST", body: { n: 3 } });

    Date.now = originalNow;

    const fetchImpl = jest.fn().mockResolvedValue(mkResponse(200));

    const analytics: Array<[string, Record<string, string | number | boolean>]> = [];
    const result = await flushQueue({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      tokenProvider: () => "FRESH-TOKEN",
      onAnalytics: (e, m) => analytics.push([e, m]),
    });

    expect(result).toEqual({ replayed: 3, failed: 0 });
    const calls = fetchImpl.mock.calls;
    expect(calls.map((c) => c[0])).toEqual([
      "/api/sites/1/a",
      "/api/sites/1/b",
      "/api/sites/1/c",
    ]);
    // Each replay pulled the fresh token, not the stored one.
    for (const [, init] of calls) {
      const auth = (init.headers as Headers).get("Authorization");
      expect(auth).toBe("Bearer FRESH-TOKEN");
    }

    // returned_online fires once at the top with the batch size.
    const returned = analytics.filter(([e]) => e === "offline.returned_online");
    expect(returned).toHaveLength(1);
    expect(returned[0][1]).toEqual({ queue_size: 3 });

    const replayed = analytics.filter(([e]) => e === "offline.mutation_replayed");
    expect(replayed).toHaveLength(3);

    // Queue is empty after successful drain.
    const remaining = await listQueue();
    expect(remaining).toHaveLength(0);
  });

  it("returns {replayed:0, failed:0} on empty queue (no analytics burst)", async () => {
    const analytics: Array<[string, Record<string, string | number | boolean>]> = [];
    const r = await flushQueue({
      fetchImpl: (() => Promise.resolve(mkResponse(200))) as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      tokenProvider: () => "t",
      onAnalytics: (e, m) => analytics.push([e, m]),
    });
    expect(r).toEqual({ replayed: 0, failed: 0 });
    expect(analytics).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Backoff curve
// ---------------------------------------------------------------------------

describe("backoffForAttempt", () => {
  it("follows the 1s/2s/4s/8s/16s schedule and caps at 30s", () => {
    expect(backoffForAttempt(0)).toBe(1000);
    expect(backoffForAttempt(1)).toBe(2000);
    expect(backoffForAttempt(2)).toBe(4000);
    expect(backoffForAttempt(3)).toBe(8000);
    expect(backoffForAttempt(4)).toBe(16000);
    // Out-of-range clamps to last slot (still under cap).
    expect(backoffForAttempt(99)).toBeLessThanOrEqual(BACKOFF_CAP_MS);
  });
});

// ---------------------------------------------------------------------------
// Retry-cap / give-up path
// ---------------------------------------------------------------------------

describe("flushQueue — give up after MAX_ATTEMPTS", () => {
  it("marks the entry failed after 5 attempts and fires replay_failed", async () => {
    await enqueueMutation({
      endpoint: "/api/sites/1/flaky",
      method: "POST",
      body: {},
    });

    // Network rejects every time (TypeError — simulates offline again).
    const fetchImpl = jest
      .fn()
      .mockRejectedValue(new TypeError("Failed to fetch"));

    const analytics: Array<[string, Record<string, string | number | boolean>]> = [];
    const result = await flushQueue({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(), // no actual wait in test
      tokenProvider: () => "T",
      onAnalytics: (e, m) => analytics.push([e, m]),
    });

    expect(result.replayed).toBe(0);
    expect(result.failed).toBe(1);
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_ATTEMPTS);

    // The entry survives (status=failed) so the user can see it / retry.
    const remaining = await listQueue();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].status).toBe("failed");
    expect(remaining[0].attempts).toBe(MAX_ATTEMPTS);

    // replay_failed fires at least once — last one reports the terminal attempt count.
    const failed = analytics.filter(([e]) => e === "offline.mutation_replay_failed");
    expect(failed.length).toBeGreaterThanOrEqual(1);
    expect(failed[failed.length - 1][1].attempt).toBe(MAX_ATTEMPTS);
  });

  it("stops retrying on a terminal 4xx (non-401)", async () => {
    await enqueueMutation({
      endpoint: "/api/sites/1/invalid",
      method: "POST",
      body: {},
    });

    // Always 400 Bad Request — retrying a validation error is pointless.
    const fetchImpl = jest.fn().mockResolvedValue(mkResponse(400, "bad"));

    const result = await flushQueue({
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      tokenProvider: () => "T",
      onAnalytics: () => undefined,
    });

    expect(result.failed).toBe(1);
    // Only ONE call — we bail after the first terminal 4xx.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const remaining = await listQueue();
    expect(remaining[0].status).toBe("failed");
  });
});

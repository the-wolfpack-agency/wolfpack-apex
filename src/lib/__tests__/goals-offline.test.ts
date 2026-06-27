/**
 * @jest-environment jsdom
 *
 * Goals offline wrapper — verifies:
 *   - `sendCommitmentOffline` POSTs inline when online + server 2xx
 *   - queues when navigator.onLine === false
 *   - queues when server returns non-ok
 *   - queues when fetch throws (network error mid-flight)
 *   - `sendGradeOffline` queues + stamps PATCH method
 *   - queued entries are replayed on reconnect (delegated to flushQueue)
 */

import "fake-indexeddb/auto";

const fetchMock = jest.fn();

// Install a localStorage shim that supplies the token our wrapper
// looks for before enqueuing.
beforeAll(() => {
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "test.jwt.token" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) {
        return this._store[k] ?? null;
      },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) {
        this._store[k] = v;
      },
      removeItem(this: { _store: Record<string, string> }, k: string) {
        delete this._store[k];
      },
      clear(this: { _store: Record<string, string> }) {
        this._store = {};
      },
    },
    writable: true,
  });
  global.fetch = fetchMock as unknown as typeof fetch;
});

beforeEach(() => {
  fetchMock.mockReset();
  Object.defineProperty(navigator, "onLine", {
    value: true,
    configurable: true,
  });
});

async function freshModule() {
  jest.resetModules();
  const queue = await import("@/lib/offline-queue");
  queue.__resetForTests();
  await queue.clearQueue();
  const mod = await import("@/lib/goals-offline");
  return { queue, mod };
}

describe("sendCommitmentOffline", () => {
  test("online + 2xx → status: sent, server id returned", async () => {
    const { mod } = await freshModule();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 201,
      json: () => Promise.resolve({ contribution: { id: "c-123" } }),
    });
    const res = await mod.sendCommitmentOffline(
      { kr_id: "kr-1", description: "ship X", committed_for_week: "2026-04-20" },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    expect(res.status).toBe("sent");
    expect(res.id).toBe("c-123");
  });

  test("offline → enqueued, status: queued, analytics fired", async () => {
    const { mod, queue } = await freshModule();
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    const emitted: Array<{ event: string; meta: Record<string, unknown> }> = [];
    const res = await mod.sendCommitmentOffline(
      { kr_id: "kr-1", description: "offline bet" },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        onAnalytics: (event, metadata) => emitted.push({ event, meta: metadata }),
      },
    );
    expect(res.status).toBe("queued");
    // The injected goals fetchImpl must NOT be hit inline while offline.
    // NOTE: `enqueueMutation` legitimately fires an `offline.mutation_queued`
    // analytics beacon through `fetchWithRefresh` (the queue layer's own
    // state-transition analytics, by design), which lands on the global
    // fetchMock. That is a separate, expected call - so assert the GOALS
    // endpoint specifically was never POSTed, not that fetch was untouched.
    const goalsCalls = fetchMock.mock.calls.filter(
      (c) => c[0] === "/api/goals/contributions",
    );
    expect(goalsCalls).toHaveLength(0);
    const q = await queue.listQueue();
    expect(q).toHaveLength(1);
    expect(q[0].endpoint).toBe("/api/goals/contributions");
    expect(q[0].method).toBe("POST");
    // Header names are normalized to lower-case by the Headers API inside
    // `stripSessionHeaders` (HTTP headers are case-insensitive).
    expect(q[0].headers["x-instinct-resource-type"]).toBe("goal_commitment");
    expect(emitted[0].event).toBe("goal.commitment_queued_offline");
    expect(emitted[0].meta.kr_id).toBe("kr-1");
  });

  test("online + non-ok → falls through to queue", async () => {
    const { mod, queue } = await freshModule();
    fetchMock.mockResolvedValueOnce({
      ok: false,
      status: 503,
      json: () => Promise.resolve({}),
    });
    const res = await mod.sendCommitmentOffline(
      { kr_id: "kr-2", description: "upstream angry" },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        onAnalytics: () => undefined,
      },
    );
    expect(res.status).toBe("queued");
    expect((await queue.listQueue())).toHaveLength(1);
  });

  test("online + fetch throws → falls through to queue", async () => {
    const { mod, queue } = await freshModule();
    fetchMock.mockRejectedValueOnce(new Error("network"));
    const res = await mod.sendCommitmentOffline(
      { kr_id: "kr-3", description: "throw" },
      {
        fetchImpl: fetchMock as unknown as typeof fetch,
        onAnalytics: () => undefined,
      },
    );
    expect(res.status).toBe("queued");
    expect((await queue.listQueue())).toHaveLength(1);
  });

  test("rejects when required fields missing", async () => {
    const { mod } = await freshModule();
    await expect(
      mod.sendCommitmentOffline(
        { kr_id: "", description: "x" },
        { fetchImpl: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/required/);
  });
});

describe("sendGradeOffline", () => {
  test("online + 2xx → status: sent", async () => {
    const { mod } = await freshModule();
    fetchMock.mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ contribution: { id: "c-1", graded_as: "hit" } }),
    });
    const res = await mod.sendGradeOffline(
      { contribution_id: "c-1", graded_as: "hit" },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    expect(res.status).toBe("sent");
    expect(res.id).toBe("c-1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/goals/contributions/c-1/grade");
    expect(init.method).toBe("PATCH");
  });

  test("offline → enqueued with PATCH method", async () => {
    const { mod, queue } = await freshModule();
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    const res = await mod.sendGradeOffline(
      { contribution_id: "c-1", graded_as: "miss" },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    expect(res.status).toBe("queued");
    const q = await queue.listQueue();
    expect(q[0].method).toBe("PATCH");
    expect(q[0].endpoint).toBe("/api/goals/contributions/c-1/grade");
    // Lower-cased by the Headers API inside `stripSessionHeaders`.
    expect(q[0].headers["x-instinct-resource-type"]).toBe("goal_grade");
  });
});

describe("replay on reconnect", () => {
  test("flushQueue drains a queued commitment", async () => {
    const { mod, queue } = await freshModule();
    // Queue one while offline.
    Object.defineProperty(navigator, "onLine", {
      value: false,
      configurable: true,
    });
    await mod.sendCommitmentOffline(
      { kr_id: "kr-7", description: "replay-me" },
      { fetchImpl: fetchMock as unknown as typeof fetch },
    );
    expect(await queue.listQueue()).toHaveLength(1);

    // Replay is performed against a fetch that returns 2xx. Inject the
    // flushQueue test seams (fetchImpl / sleep / tokenProvider /
    // onAnalytics) the same way offline-queue.test.ts does - otherwise
    // the default onAnalytics fires real `fetchWithRefresh` beacons that
    // hit the un-mocked global fetch and the test hangs (5s timeout).
    Object.defineProperty(navigator, "onLine", {
      value: true,
      configurable: true,
    });
    const replayFetch = jest.fn().mockResolvedValue({
      ok: true,
      status: 201,
      text: () => Promise.resolve(""),
    });
    const result = await queue.flushQueue({
      fetchImpl: replayFetch as unknown as typeof fetch,
      sleep: () => Promise.resolve(),
      tokenProvider: () => "test.jwt.token",
      onAnalytics: () => undefined,
    });
    expect(result.replayed).toBe(1);
    expect(replayFetch).toHaveBeenCalledTimes(1);
    expect(await queue.listQueue()).toHaveLength(0);
  });
});

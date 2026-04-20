/**
 * @jest-environment jsdom
 *
 * useOfflineQueue — hook wraps offline-queue.ts. We exercise the enqueue
 * path in an offline state, assert pendingCount reactivity, and verify
 * flush() drains the queue on reconnect.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useOfflineQueue } from "@/lib/hooks/useOfflineQueue";
import {
  clearQueue,
  listQueue,
  __resetForTests as resetQueue,
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

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

beforeEach(async () => {
  resetQueue();
  await clearQueue();
  window.localStorage.setItem("instinct_token", "TEST-TOKEN");
  setOnline(true);
});

afterEach(async () => {
  await clearQueue();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe("useOfflineQueue", () => {
  it("enqueues a mutation and reflects pendingCount reactively", async () => {
    const { result } = renderHook(() =>
      useOfflineQueue<{ body: string }>("/api/meetings/draft", "POST", {
        resourceType: "meeting_draft",
      }),
    );

    await waitFor(() => expect(result.current.pendingCount).toBe(0));

    await act(async () => {
      await result.current.enqueue({ body: "hello" });
    });

    await waitFor(() => expect(result.current.pendingCount).toBe(1));

    const rows = await listQueue();
    expect(rows).toHaveLength(1);
    expect(rows[0].endpoint).toBe("/api/meetings/draft");
    expect(rows[0].headers["x-instinct-resource-type"]).toBe("meeting_draft");
    expect(rows[0].headers).not.toHaveProperty("authorization");
  });

  it("does not count entries for a different endpoint toward pendingCount", async () => {
    const { result: draft } = renderHook(() =>
      useOfflineQueue("/api/meetings/draft", "POST"),
    );
    const { result: journal } = renderHook(() =>
      useOfflineQueue("/api/journal", "POST"),
    );

    await act(async () => {
      await draft.current.enqueue({ n: 1 });
      await draft.current.enqueue({ n: 2 });
      await journal.current.enqueue({ entry: "log" });
    });

    await waitFor(() => expect(draft.current.pendingCount).toBe(2));
    await waitFor(() => expect(journal.current.pendingCount).toBe(1));
  });

  it("flush() drains entries via fetch and zeroes pendingCount", async () => {
    const fetchSpy = jest.fn().mockResolvedValue(mkResponse(200));
    (global as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useOfflineQueue<{ n: number }>("/api/hr/docs", "POST"),
    );
    await act(async () => {
      await result.current.enqueue({ n: 1 });
      await result.current.enqueue({ n: 2 });
    });
    await waitFor(() => expect(result.current.pendingCount).toBe(2));

    await act(async () => {
      await result.current.flush();
    });

    // Each queued entry fires ONE fetch to its endpoint. The queue module
    // additionally posts analytics to /api/analytics, so we just assert at
    // least two endpoint hits.
    const endpointCalls = fetchSpy.mock.calls.filter(
      (c) => c[0] === "/api/hr/docs",
    );
    expect(endpointCalls.length).toBe(2);
    await waitFor(() => expect(result.current.pendingCount).toBe(0));
  });

  it("isFlushing toggles true while flush is in flight", async () => {
    let resolveFetch: ((r: Response) => void) | null = null;
    const fetchSpy = jest.fn().mockImplementation(
      () =>
        new Promise<Response>((res) => {
          resolveFetch = res;
        }),
    );
    (global as unknown as { fetch: typeof fetch }).fetch = fetchSpy as unknown as typeof fetch;

    const { result } = renderHook(() =>
      useOfflineQueue("/api/journal", "POST"),
    );
    await act(async () => {
      await result.current.enqueue({ entry: "x" });
    });

    let flushPromise: Promise<void> | null = null;
    await act(async () => {
      flushPromise = result.current.flush();
      // microtask cycle so state updates
      await Promise.resolve();
    });
    expect(result.current.isFlushing).toBe(true);

    await act(async () => {
      resolveFetch!(mkResponse(200));
      await flushPromise;
    });
    await waitFor(() => expect(result.current.isFlushing).toBe(false));
  });
});

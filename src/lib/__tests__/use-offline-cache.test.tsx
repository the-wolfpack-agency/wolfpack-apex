/**
 * @jest-environment jsdom
 *
 * useOfflineCache — success → fresh data cached. Failure → cached data
 * returned with isStale=true. Coming back online while stale → auto-refetch.
 */

import "fake-indexeddb/auto";
import "@testing-library/jest-dom";
import { act, renderHook, waitFor } from "@testing-library/react";
import { useOfflineCache } from "@/lib/hooks/useOfflineCache";
import {
  cacheResource,
  clearAllResources,
  __resetForTests,
} from "@/lib/offline-cache";

function setOnline(value: boolean) {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
}

beforeEach(async () => {
  __resetForTests();
  await clearAllResources();
  setOnline(true);
  window.localStorage.setItem("instinct_token", "T");
});

afterEach(async () => {
  await clearAllResources();
  window.localStorage.clear();
  jest.restoreAllMocks();
});

describe("useOfflineCache — fresh path", () => {
  it("fetches + returns fresh data and writes it to the cache", async () => {
    const fetcher = jest.fn().mockResolvedValue({ title: "Fresh" });
    const { result } = renderHook(() =>
      useOfflineCache<{ title: string }>("meeting_draft", "d-1", fetcher),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual({ title: "Fresh" });
    expect(result.current.isStale).toBe(false);
    expect(result.current.cacheAgeMs).toBe(0);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("useOfflineCache — stale fallback path", () => {
  it("returns cached data with isStale=true when fetcher rejects", async () => {
    // Seed the cache so the fallback can return something.
    const t0 = 7_000_000_000_000;
    const nowSpy = jest.spyOn(Date, "now").mockReturnValue(t0);
    await cacheResource("meeting_draft", "d-stale", { title: "Older" });
    nowSpy.mockReturnValue(t0 + 45_000);

    const fetcher = jest.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() =>
      useOfflineCache<{ title: string }>("meeting_draft", "d-stale", fetcher),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toEqual({ title: "Older" });
    expect(result.current.isStale).toBe(true);
    expect(result.current.cacheAgeMs).toBe(45_000);
  });

  it("returns null (not isStale) when fetcher rejects and no cache exists", async () => {
    const fetcher = jest.fn().mockRejectedValue(new Error("offline"));
    const { result } = renderHook(() =>
      useOfflineCache<{ title: string }>("hr_doc_pending", "never", fetcher),
    );

    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(result.current.data).toBeNull();
    expect(result.current.isStale).toBe(false);
    expect(result.current.cacheAgeMs).toBeNull();
  });
});

describe("useOfflineCache — returning online refetches stale data", () => {
  it("auto-refetches when online event fires and state is stale", async () => {
    await cacheResource("journal_entry", "j-1", { body: "cached" });

    let callCount = 0;
    const fetcher = jest.fn().mockImplementation(() => {
      callCount += 1;
      // First call fails (offline), second succeeds (back online).
      return callCount === 1
        ? Promise.reject(new Error("offline"))
        : Promise.resolve({ body: "fresh" });
    });

    const { result } = renderHook(() =>
      useOfflineCache<{ body: string }>("journal_entry", "j-1", fetcher),
    );

    await waitFor(() => expect(result.current.isStale).toBe(true));
    expect(result.current.data).toEqual({ body: "cached" });

    await act(async () => {
      window.dispatchEvent(new Event("online"));
    });

    await waitFor(() => expect(result.current.isStale).toBe(false));
    expect(result.current.data).toEqual({ body: "fresh" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

describe("useOfflineCache — manual refetch()", () => {
  it("re-runs the fetcher and updates state", async () => {
    let payload = { v: 1 };
    const fetcher = jest.fn().mockImplementation(() => Promise.resolve(payload));
    const { result } = renderHook(() =>
      useOfflineCache<{ v: number }>("knowledge", "k-1", fetcher),
    );

    await waitFor(() => expect(result.current.data).toEqual({ v: 1 }));

    payload = { v: 2 };
    await act(async () => {
      await result.current.refetch();
    });
    expect(result.current.data).toEqual({ v: 2 });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});

/**
 * Coalesced fetch — concurrent identical GETs collapse to one HTTP
 * request. Non-GETs and disabled-flag paths bypass the cache.
 */
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: jest.fn(),
}));

import { fetchWithRefresh } from "@/lib/client-auth";
import {
  coalescedFetchWithRefresh,
  __resetCoalescedFetchForTests,
} from "../coalesced-fetch";

const mockFetch = fetchWithRefresh as jest.MockedFunction<
  typeof fetchWithRefresh
>;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  __resetCoalescedFetchForTests();
  mockFetch.mockReset();
  // Force optimization ON for these tests — the production default is
  // ON, but the module auto-disables under jest unless told otherwise.
  process.env.NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE = "true";
});

afterEach(() => {
  delete process.env.NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE;
});

describe("coalescedFetchWithRefresh", () => {
  it("collapses 3 concurrent GETs to the same URL into 1 fetch", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ count: 7 }));

    const [a, b, c] = await Promise.all([
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(await a.json()).toEqual({ count: 7 });
    expect(await b.json()).toEqual({ count: 7 });
    expect(await c.json()).toEqual({ count: 7 });
  });

  it("does NOT collapse different URLs", async () => {
    mockFetch.mockImplementation(async (url) =>
      jsonResponse({ url: String(url) }),
    );

    await Promise.all([
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
      coalescedFetchWithRefresh("/api/microsoft/messages/unread-count"),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("does NOT collapse non-GET methods (preserves side effects)", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ok: true }));

    await Promise.all([
      coalescedFetchWithRefresh("/api/analytics", { method: "POST" }),
      coalescedFetchWithRefresh("/api/analytics", { method: "POST" }),
    ]);

    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after the coalesce window elapses", async () => {
    jest.useFakeTimers();
    mockFetch.mockResolvedValue(jsonResponse({ count: 1 }));

    await coalescedFetchWithRefresh("/api/ms/chats/unread-count", {}, 100);
    expect(mockFetch).toHaveBeenCalledTimes(1);

    // Advance past the cache window — next fetch must hit the network.
    jest.advanceTimersByTime(150);
    await Promise.resolve();
    await coalescedFetchWithRefresh("/api/ms/chats/unread-count", {}, 100);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    jest.useRealTimers();
  });

  it("falls back to plain fetchWithRefresh when flag is disabled", async () => {
    process.env.NEXT_PUBLIC_INSTINCT_BADGE_OPTIMIZE = "false";
    mockFetch.mockResolvedValue(jsonResponse({ count: 1 }));

    await Promise.all([
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
    ]);

    // Both go to the network because optimization is off.
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after a rejected coalesced Promise", async () => {
    mockFetch
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce(jsonResponse({ count: 3 }));

    await expect(
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
    ).rejects.toThrow("network");

    const ok = await coalescedFetchWithRefresh(
      "/api/ms/chats/unread-count",
    );
    expect(await ok.json()).toEqual({ count: 3 });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it("returns independently-readable Response clones to each caller", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ count: 5 }));

    const [a, b] = await Promise.all([
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
      coalescedFetchWithRefresh("/api/ms/chats/unread-count"),
    ]);

    // Both callers must be able to consume the body — a shared
    // Response would fail the second .json() with "body already
    // read". Cloning is the contract.
    expect(await a.json()).toEqual({ count: 5 });
    expect(await b.json()).toEqual({ count: 5 });
  });
});

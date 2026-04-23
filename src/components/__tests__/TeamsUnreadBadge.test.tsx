/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

/**
 * Component: <TeamsUnreadBadge />
 *
 * Behavior under test:
 *   1. count === 0 hides the badge entirely.
 *   2. count > 0 renders with a /messages link + accessible label.
 *   3. Clicking fires messages.unread_badge_clicked analytics, sets
 *      localStorage instinct.messages.last_seen to a fresh ISO stamp,
 *      navigates to /messages, and optimistically zeroes the badge.
 *   4. scope_missing response hides silently (no badge, no error UI).
 *   5. connected:false response hides silently.
 *   6. Polling interval re-fires the fetch (jest fake timers).
 *   7. Window-focus listener triggers an off-schedule fetch.
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn(() => "fake-token");
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  getInstinctToken: (...a: any[]) => mockGetInstinctToken(...a),
}));

const mockPush = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
}));

import { act, render, screen, waitFor } from "@testing-library/react";
import TeamsUnreadBadge from "@/components/TeamsUnreadBadge";

jest.useFakeTimers();

function mkJsonResponse(body: unknown, ok = true, status = 200): any {
  return {
    ok,
    status,
    json: async () => body,
  };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockPush.mockReset();
  mockGetInstinctToken.mockReturnValue("fake-token");
  window.localStorage.clear();
});

afterEach(() => {
  jest.clearAllTimers();
});

describe("<TeamsUnreadBadge />", () => {
  test("hides entirely when count === 0", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 0, total_chats: 3, since: null }),
    );

    const { container } = render(<TeamsUnreadBadge />);
    await act(async () => {
      await Promise.resolve();
    });

    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    expect(container.querySelector("[data-testid='teams-unread-badge']")).toBeNull();
  });

  test("renders the badge when count > 0", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 3, total_chats: 5, since: "2026-04-22T00:00:00Z" }),
    );

    render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

    const badge = await screen.findByTestId("teams-unread-badge");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("href", "/messages");
    expect(screen.getByTestId("teams-unread-badge-count").textContent).toBe("3");
    expect(badge.getAttribute("aria-label")).toMatch(/3 new/);
  });

  test("caps display at 99+", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 412, total_chats: 500, since: null }),
    );

    render(<TeamsUnreadBadge />);
    await waitFor(() => {
      expect(screen.getByTestId("teams-unread-badge-count").textContent).toBe("99+");
    });
  });

  test("click fires analytics, writes last_seen, navigates, and clears the badge", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 2, total_chats: 4, since: null }),
    );

    render(<TeamsUnreadBadge />);
    const badge = await screen.findByTestId("teams-unread-badge");

    // Reset so we can inspect the analytics fetch specifically.
    mockFetchWithRefresh.mockClear();
    // Next fetch (the analytics POST) should still resolve.
    mockFetchWithRefresh.mockResolvedValue(mkJsonResponse({ ok: true }));

    await act(async () => {
      badge.click();
    });

    const analyticsCall = mockFetchWithRefresh.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0] === "/api/analytics",
    );
    expect(analyticsCall).toBeDefined();
    const body = JSON.parse(analyticsCall![1].body);
    expect(body.event).toBe("messages.unread_badge_clicked");
    expect(body.metadata).toEqual({ count: 2 });

    const lastSeen = window.localStorage.getItem("instinct.messages.last_seen");
    expect(lastSeen).toBeTruthy();
    expect(Number.isNaN(Date.parse(lastSeen!))).toBe(false);

    expect(mockPush).toHaveBeenCalledWith("/messages");

    // Badge is optimistically zeroed, so it unmounts after the click.
    await waitFor(() => {
      expect(screen.queryByTestId("teams-unread-badge")).toBeNull();
    });
  });

  test("scope_missing hides silently (no badge, no error UI)", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 0, scope_missing: true }),
    );

    const { container } = render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

    expect(container.querySelector("[data-testid='teams-unread-badge']")).toBeNull();
    // No stray text content that would look like an error.
    expect(container.textContent || "").toBe("");
  });

  test("connected:false hides silently", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 0, connected: false }),
    );

    const { container } = render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

    expect(container.querySelector("[data-testid='teams-unread-badge']")).toBeNull();
  });

  test("polling interval re-fires the fetch every 45s", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 0, total_chats: 0, since: null }),
    );

    render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));

    await act(async () => {
      jest.advanceTimersByTime(45_000);
    });
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2));

    await act(async () => {
      jest.advanceTimersByTime(45_000);
    });
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(3));
  });

  test("window focus triggers an off-schedule fetch", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 0, total_chats: 0, since: null }),
    );

    render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));

    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });

    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2));
  });

  test("sends ?since= when localStorage has a last_seen timestamp", async () => {
    const since = "2026-04-22T08:30:00.000Z";
    window.localStorage.setItem("instinct.messages.last_seen", since);

    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 0, total_chats: 0, since }),
    );

    render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());

    const url = mockFetchWithRefresh.mock.calls[0][0];
    expect(url).toBe(
      `/api/ms/chats/unread-count?since=${encodeURIComponent(since)}`,
    );
  });

  test("skips fetch entirely when there is no instinct token", async () => {
    mockGetInstinctToken.mockReturnValue(null);

    render(<TeamsUnreadBadge />);
    // No poll should have fired.
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });
});

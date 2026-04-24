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
const mockGetInstinctToken = jest.fn<string | null, []>(() => "fake-token");
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  getInstinctToken: () => mockGetInstinctToken(),
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

  test("polling interval re-fires the fetch every 5s when tab is visible", async () => {
    // Adaptive polling: 5s while visible (jsdom default), 45s when
    // hidden. Old static-45s assertion is now too coarse.
    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 0, total_chats: 0, since: null }),
    );

    render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));

    await act(async () => {
      jest.advanceTimersByTime(5_000);
    });
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2));

    await act(async () => {
      jest.advanceTimersByTime(5_000);
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

  test("tags document.title with (N) prefix when count > 0 and restores it at zero", async () => {
    document.title = "Instinct";
    let response = mkJsonResponse({ count: 3, total_chats: 5 });
    mockFetchWithRefresh.mockImplementation(() => Promise.resolve(response));

    render(<TeamsUnreadBadge />);
    await waitFor(() => expect(document.title).toBe("(3) Instinct"));

    // Drop the count to zero on next poll → title restores.
    response = mkJsonResponse({ count: 0, total_chats: 5 });
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(document.title).toBe("Instinct"));
  });

  test("fires a browser notification when count increases between polls", async () => {
    // Stub the Notification API. jsdom doesn't implement it.
    const notificationCtor = jest.fn();
    (notificationCtor as unknown as { permission: NotificationPermission }).permission =
      "granted";
    (notificationCtor as unknown as {
      requestPermission: () => Promise<NotificationPermission>;
    }).requestPermission = () => Promise.resolve("granted");
    (window as unknown as { Notification: unknown }).Notification = notificationCtor;

    // Pretend we're not on /messages so the gate allows notification.
    window.history.pushState({}, "", "/dashboard");

    let response = mkJsonResponse({ count: 1, total_chats: 5 });
    mockFetchWithRefresh.mockImplementation(() => Promise.resolve(response));

    render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    // First mount: count goes 0 → 1, that IS an increase, notification fires once.
    await waitFor(() => expect(notificationCtor).toHaveBeenCalledTimes(1));
    expect(notificationCtor.mock.calls[0][0]).toBe("New Teams message");

    // Same count on next poll: NO new notification (no increase).
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(notificationCtor).toHaveBeenCalledTimes(1);

    // Bump to 4: delta is 3, plural copy fires.
    response = mkJsonResponse({ count: 4, total_chats: 5 });
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    await waitFor(() => expect(notificationCtor).toHaveBeenCalledTimes(2));
    expect(notificationCtor.mock.calls[1][0]).toBe("3 new Teams messages");
  });

  test("does NOT fire a browser notification when user is already on /messages", async () => {
    const notificationCtor = jest.fn();
    (notificationCtor as unknown as { permission: NotificationPermission }).permission =
      "granted";
    (window as unknown as { Notification: unknown }).Notification = notificationCtor;

    window.history.pushState({}, "", "/messages");

    mockFetchWithRefresh.mockResolvedValue(
      mkJsonResponse({ count: 5, total_chats: 5 }),
    );

    render(<TeamsUnreadBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    // Give effects time to settle.
    await act(async () => {
      await Promise.resolve();
    });
    expect(notificationCtor).not.toHaveBeenCalled();
  });
});

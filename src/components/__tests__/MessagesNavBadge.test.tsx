/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

/**
 * Component: <MessagesNavBadge />
 *
 * Sidebar dot for the Messages nav item. Same polling contract as
 * TeamsUnreadBadge: visible when count > 0, silently hidden on
 * scope_missing / connected:false / no token / non-200, refreshed
 * on focus + 45s interval.
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn<string | null, []>(() => "fake-token");
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  getInstinctToken: () => mockGetInstinctToken(),
}));

import { act, render, screen, waitFor } from "@testing-library/react";
import MessagesNavBadge from "@/components/MessagesNavBadge";

jest.useFakeTimers();

function mkRes(body: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => body };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReturnValue("fake-token");
  window.localStorage.clear();
});

afterEach(() => jest.clearAllTimers());

describe("<MessagesNavBadge />", () => {
  it("hides entirely when count === 0", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 0 }));
    const { container } = render(<MessagesNavBadge />);
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="messages-nav-badge"]')).toBeNull();
  });

  it("renders the badge with the count when > 0", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 3 }));
    render(<MessagesNavBadge />);
    const badge = await screen.findByTestId("messages-nav-badge");
    expect(badge).toHaveTextContent("3");
    expect(badge).toHaveAttribute("aria-label", "3 unread Teams messages");
  });

  it("caps display at 99+", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 250 }));
    render(<MessagesNavBadge />);
    const badge = await screen.findByTestId("messages-nav-badge");
    expect(badge).toHaveTextContent("99+");
  });

  it("uses singular 'message' in aria-label when count === 1", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 1 }));
    render(<MessagesNavBadge />);
    const badge = await screen.findByTestId("messages-nav-badge");
    expect(badge).toHaveAttribute("aria-label", "1 unread Teams message");
  });

  it("scope_missing hides silently", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ count: 5, scope_missing: true }),
    );
    const { container } = render(<MessagesNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="messages-nav-badge"]')).toBeNull();
  });

  it("connected:false hides silently", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ count: 5, connected: false }),
    );
    const { container } = render(<MessagesNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="messages-nav-badge"]')).toBeNull();
  });

  it("re-polls on the 45s interval", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 1 }));
    render(<MessagesNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));
    await act(async () => {
      jest.advanceTimersByTime(5_000);
      await Promise.resolve();
    });
    expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2);
  });

  it("re-polls on window focus", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 1 }));
    render(<MessagesNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2);
  });

  it("skips fetch entirely when there is no instinct token", async () => {
    mockGetInstinctToken.mockReturnValue(null);
    render(<MessagesNavBadge />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });
});

// Layout integration — assert the badge is mounted next to the
// Messages nav item via source-text inspection (avoids mounting the
// whole dashboard layout with all its auth/router deps).
describe("dashboard layout — MessagesNavBadge mount", () => {
  test("layout imports MessagesNavBadge", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const layout = readFileSync(
      resolve(__dirname, "../../app/(dashboard)/layout.tsx"),
      "utf8",
    );
    expect(layout).toMatch(/import\s+MessagesNavBadge\s+from/);
  });

  test("layout renders MessagesNavBadge only for the /messages nav item", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const layout = readFileSync(
      resolve(__dirname, "../../app/(dashboard)/layout.tsx"),
      "utf8",
    );
    // The conditional render lives in the nav-items map.
    expect(layout).toMatch(
      /item\.href\s*===\s*["']\/messages["']\s*\?\s*<MessagesNavBadge/,
    );
  });
});

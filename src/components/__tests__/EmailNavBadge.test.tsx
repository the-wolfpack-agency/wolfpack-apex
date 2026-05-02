/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

/**
 * Component: <EmailNavBadge />
 *
 * Sidebar pill for the Emails nav item. Same polling contract as
 * MessagesNavBadge: visible when count > 0, silently hidden on
 * scope_missing / connected:false / no token / non-200, refreshed
 * on focus + adaptive interval.
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn<string | null, []>(() => "fake-token");
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  getInstinctToken: () => mockGetInstinctToken(),
}));

import { act, render, screen, waitFor } from "@testing-library/react";
import EmailNavBadge from "@/components/EmailNavBadge";

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

describe("<EmailNavBadge />", () => {
  it("hides entirely when count === 0", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 0 }));
    const { container } = render(<EmailNavBadge />);
    await act(async () => {
      await Promise.resolve();
    });
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="email-nav-badge"]')).toBeNull();
  });

  it("renders the badge with the count when > 0", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 4 }));
    render(<EmailNavBadge />);
    const badge = await screen.findByTestId("email-nav-badge");
    expect(badge).toHaveTextContent("4");
    expect(badge).toHaveAttribute("aria-label", "4 unread emails");
  });

  it("caps display at 99+", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 250 }));
    render(<EmailNavBadge />);
    const badge = await screen.findByTestId("email-nav-badge");
    expect(badge).toHaveTextContent("99+");
  });

  it("uses singular 'email' in aria-label when count === 1", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 1 }));
    render(<EmailNavBadge />);
    const badge = await screen.findByTestId("email-nav-badge");
    expect(badge).toHaveAttribute("aria-label", "1 unread email");
  });

  it("scope_missing hides silently", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ count: 5, scope_missing: true }),
    );
    const { container } = render(<EmailNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="email-nav-badge"]')).toBeNull();
  });

  it("connected:false hides silently", async () => {
    mockFetchWithRefresh.mockResolvedValue(
      mkRes({ count: 5, connected: false }),
    );
    const { container } = render(<EmailNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="email-nav-badge"]')).toBeNull();
  });

  it("non-200 hides silently", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({}, false, 500));
    const { container } = render(<EmailNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="email-nav-badge"]')).toBeNull();
  });

  it("re-polls on the visible interval", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 1 }));
    render(<EmailNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));
    // Visible cadence is 30s after the May 2026 polling-efficiency
    // pass (was 5s — see useAdaptivePoll defaults).
    await act(async () => {
      jest.advanceTimersByTime(30_000);
      await Promise.resolve();
    });
    expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2);
  });

  it("re-polls on window focus", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 1 }));
    render(<EmailNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalledTimes(1));
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
      await Promise.resolve();
    });
    expect(mockFetchWithRefresh).toHaveBeenCalledTimes(2);
  });

  it("skips fetch entirely when there is no instinct token", async () => {
    mockGetInstinctToken.mockReturnValue(null);
    render(<EmailNavBadge />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });

  it("appends ?since= when a last_seen timestamp is set", async () => {
    const iso = "2026-04-29T00:00:00.000Z";
    window.localStorage.setItem("instinct.emails.last_seen", iso);
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 2 }));
    render(<EmailNavBadge />);
    await waitFor(() => expect(mockFetchWithRefresh).toHaveBeenCalled());
    const calledUrl = mockFetchWithRefresh.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/api/microsoft/messages/unread-count");
    expect(calledUrl).toContain(`since=${encodeURIComponent(iso)}`);
  });

  it("clears the badge when /emails dispatches instinct:emails-seen", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkRes({ count: 3 }));
    const { container } = render(<EmailNavBadge />);
    await screen.findByTestId("email-nav-badge");

    await act(async () => {
      window.dispatchEvent(new Event("instinct:emails-seen"));
      await Promise.resolve();
    });

    expect(
      container.querySelector('[data-testid="email-nav-badge"]'),
    ).toBeNull();
    expect(window.localStorage.getItem("instinct.emails.last_seen")).not.toBeNull();
  });
});

// Layout integration — assert the badge is mounted next to the
// Emails nav item via source-text inspection (mirrors the
// MessagesNavBadge integration check).
describe("dashboard layout — EmailNavBadge mount", () => {
  test("layout imports EmailNavBadge", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const layout = readFileSync(
      resolve(__dirname, "../../app/(dashboard)/layout.tsx"),
      "utf8",
    );
    expect(layout).toMatch(/import\s+EmailNavBadge\s+from/);
  });

  test("layout renders EmailNavBadge only for the /emails nav item", async () => {
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    const layout = readFileSync(
      resolve(__dirname, "../../app/(dashboard)/layout.tsx"),
      "utf8",
    );
    expect(layout).toMatch(
      /item\.href\s*===\s*["']\/emails["']\s*\?\s*<EmailNavBadge/,
    );
  });
});

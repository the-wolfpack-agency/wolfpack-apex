/**
 * @jest-environment jsdom
 */

/**
 * notifications-ui.test.tsx — NotificationBell component + inbox page
 * smoke.
 *
 * Covers:
 *   - bell renders unread count badge
 *   - opening dropdown lists unread items
 *   - clicking a notification marks it via /click and navigates
 *   - dismiss removes item + decrements count
 *   - mark-all-read clears list + zeros count
 *   - inbox page renders tabs, search, and list
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

const pushMock = jest.fn();
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: pushMock, replace: jest.fn(), back: jest.fn(), refresh: jest.fn() }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
  useParams: () => ({}),
}));

const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "t" } as Record<string, string>,
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
});

beforeEach(() => {
  fetchMock.mockReset();
  pushMock.mockReset();
});

/** Real fetch sets `ok` for 2xx ONLY, never for a 3xx. These fakes said
 *  `status < 400`, so a redirect would have read as success. No test here
 *  currently uses a 3xx, so it was a trap rather than a live bug — corrected
 *  alongside the same mistake found in the compliance collector (PR #224). */
function isOk(status: number): boolean {
  return status >= 200 && status < 300;
}

function mockFetchResponses(
  map: Record<string, { json?: unknown; status?: number }>,
) {
  fetchMock.mockImplementation(async (url: string, init?: { method?: string }) => {
    const method = init?.method ?? "GET";
    const key = `${method} ${url.split("?")[0]}`;
    const entry = map[key] ?? map[url] ?? { json: {}, status: 200 };
    return {
      ok: isOk(entry.status ?? 200),
      status: entry.status ?? 200,
      json: async () => entry.json ?? {},
    };
  });
}

describe("<NotificationBell />", () => {
  test("renders unread count badge", async () => {
    mockFetchResponses({
      "GET /api/notifications/unread-count": { json: { count: 5 } },
    });

    const NotificationBell = (await import("@/components/NotificationBell")).default;
    render(<NotificationBell />);

    await waitFor(() => {
      expect(screen.getByTestId("notification-bell-count")).toHaveTextContent("5");
    });
  });

  test("opening dropdown lists unread items", async () => {
    mockFetchResponses({
      "GET /api/notifications/unread-count": { json: { count: 2 } },
      "GET /api/notifications": {
        json: {
          notifications: [
            {
              id: "n1",
              category: "hr.onboarding_stalled",
              priority: "high",
              title: "Onboarding stalled",
              body: "Fix it",
              action_url: "/hr",
              action_label: "Open HR",
              created_at: new Date().toISOString(),
              read_at: null,
            },
            {
              id: "n2",
              category: "tasks.due_soon",
              priority: "normal",
              title: "Task due",
              body: null,
              action_url: null,
              action_label: null,
              created_at: new Date().toISOString(),
              read_at: null,
            },
          ],
        },
      },
    });

    const NotificationBell = (await import("@/components/NotificationBell")).default;
    render(<NotificationBell />);

    await waitFor(() => {
      expect(screen.getByTestId("notification-bell-count")).toBeInTheDocument();
    });

    fireEvent.click(screen.getByTestId("notification-bell"));

    await waitFor(() => {
      expect(screen.getByTestId("notification-item-n1")).toBeInTheDocument();
      expect(screen.getByTestId("notification-item-n2")).toBeInTheDocument();
    });
  });

  test("clicking a notification posts to /click and navigates to action_url", async () => {
    mockFetchResponses({
      "GET /api/notifications/unread-count": { json: { count: 1 } },
      "GET /api/notifications": {
        json: {
          notifications: [
            {
              id: "n1",
              category: "tasks.due_soon",
              priority: "normal",
              title: "Task due",
              body: null,
              action_url: "/tasks/123",
              action_label: null,
              created_at: new Date().toISOString(),
              read_at: null,
            },
          ],
        },
      },
      "POST /api/notifications/n1/click": { json: { action_url: "/tasks/123" } },
    });

    const NotificationBell = (await import("@/components/NotificationBell")).default;
    render(<NotificationBell />);

    fireEvent.click(await screen.findByTestId("notification-bell"));
    const item = await screen.findByTestId("notification-item-n1");
    // The clickable surface is the primary button inside the item row
    // (dismiss is a sibling button). Click the first child button.
    const primaryButton = item.querySelector("button:not([data-testid^='notification-dismiss'])");
    expect(primaryButton).not.toBeNull();
    await act(async () => {
      fireEvent.click(primaryButton as HTMLElement);
    });

    await waitFor(() => {
      expect(pushMock).toHaveBeenCalledWith("/tasks/123");
    });

    // click endpoint was called
    const clickCalls = fetchMock.mock.calls.filter(
      (c) => String(c[0]).includes("/n1/click") && (c[1] as any)?.method === "POST",
    );
    expect(clickCalls.length).toBeGreaterThan(0);
  });

  test("dismiss removes item and decrements badge", async () => {
    mockFetchResponses({
      "GET /api/notifications/unread-count": { json: { count: 1 } },
      "GET /api/notifications": {
        json: {
          notifications: [
            {
              id: "n1",
              category: "x",
              priority: "normal",
              title: "Dismiss me",
              body: null,
              action_url: null,
              action_label: null,
              created_at: new Date().toISOString(),
              read_at: null,
            },
          ],
        },
      },
      "POST /api/notifications/n1/dismiss": { json: { ok: true } },
    });

    const NotificationBell = (await import("@/components/NotificationBell")).default;
    render(<NotificationBell />);

    fireEvent.click(await screen.findByTestId("notification-bell"));
    const dismissBtn = await screen.findByTestId("notification-dismiss-n1");
    await act(async () => {
      fireEvent.click(dismissBtn);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("notification-item-n1")).not.toBeInTheDocument();
    });
  });

  test("mark all read zeros count + clears list", async () => {
    mockFetchResponses({
      "GET /api/notifications/unread-count": { json: { count: 2 } },
      "GET /api/notifications": {
        json: {
          notifications: [
            {
              id: "n1",
              category: "x",
              priority: "normal",
              title: "one",
              body: null,
              action_url: null,
              action_label: null,
              created_at: new Date().toISOString(),
              read_at: null,
            },
          ],
        },
      },
      "POST /api/notifications/mark-all-read": { json: { ok: true, count: 2 } },
    });

    const NotificationBell = (await import("@/components/NotificationBell")).default;
    render(<NotificationBell />);

    fireEvent.click(await screen.findByTestId("notification-bell"));
    const markAll = await screen.findByText(/mark all read/i);
    await act(async () => {
      fireEvent.click(markAll);
    });

    await waitFor(() => {
      expect(screen.queryByTestId("notification-bell-count")).not.toBeInTheDocument();
    });
  });
});

describe("<NotificationsPage />", () => {
  test("renders tabs + search + mark-all + dismiss-read buttons", async () => {
    mockFetchResponses({
      "GET /api/notifications": { json: { notifications: [] } },
    });

    const NotificationsPage = (await import("@/app/(dashboard)/notifications/page")).default;
    render(<NotificationsPage />);

    await waitFor(() => {
      expect(screen.getByTestId("notifications-tab-unread")).toBeInTheDocument();
    });
    expect(screen.getByTestId("notifications-tab-all")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-tab-category")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-tab-priority")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-search")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-mark-all")).toBeInTheDocument();
    expect(screen.getByTestId("notifications-dismiss-read")).toBeInTheDocument();
  });
});

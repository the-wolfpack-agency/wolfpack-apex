/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

/**
 * Component: <NewMessageToast />
 *
 * Behavior under test:
 *   1. Renders nothing on first poll (establishes baseline).
 *   2. Renders nothing when count drops or stays the same.
 *   3. Slides in when count grows between polls; copy reflects delta.
 *   4. Click opens /messages + writes last_seen + clears toast.
 *   5. Dismiss (✕) clears toast WITHOUT writing last_seen — badge
 *      keeps reminding.
 *   6. Suppressed when pathname === "/messages" (user already there).
 *   7. scope_missing / connected:false responses keep it silent.
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn<string | null, []>(() => "fake-token");
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  getInstinctToken: () => mockGetInstinctToken(),
}));

const mockPush = jest.fn();
let currentPath = "/";
jest.mock("next/navigation", () => ({
  useRouter: () => ({ push: mockPush }),
  usePathname: () => currentPath,
}));

// Stub the adaptive poll hook — call the callback manually from tests.
const pollCallbacks: Array<() => void> = [];
jest.mock("@/lib/hooks/useAdaptivePoll", () => ({
  useAdaptivePoll: (cb: () => void) => {
    pollCallbacks.push(cb);
  },
}));

import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import NewMessageToast from "@/components/NewMessageToast";

function mkJsonResponse(body: unknown, ok = true, status = 200): any {
  return { ok, status, json: async () => body };
}

async function poll() {
  // Drain every registered callback (the most recent mount registers
  // its own; older callbacks from prior renders are noops because their
  // closures point at unmounted state).
  await act(async () => {
    for (const cb of pollCallbacks) cb();
    await Promise.resolve();
    await Promise.resolve();
  });
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockPush.mockReset();
  mockGetInstinctToken.mockReturnValue("fake-token");
  window.localStorage.clear();
  pollCallbacks.length = 0;
  currentPath = "/";
});

describe("<NewMessageToast />", () => {
  test("first poll establishes baseline and renders nothing", async () => {
    mockFetchWithRefresh.mockResolvedValue(mkJsonResponse({ count: 3 }));
    render(<NewMessageToast />);
    await poll();
    expect(screen.queryByTestId("new-message-toast")).toBeNull();
  });

  test("renders when count grows between polls", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkJsonResponse({ count: 1 }))
      .mockResolvedValueOnce(mkJsonResponse({ count: 4 }));
    render(<NewMessageToast />);
    await poll(); // baseline 1
    await poll(); // grows to 4
    const toast = await screen.findByTestId("new-message-toast");
    expect(toast).toBeInTheDocument();
    expect(toast.textContent).toMatch(/3 new Teams messages/i);
  });

  test("singular copy when delta === 1", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkJsonResponse({ count: 0 }))
      .mockResolvedValueOnce(mkJsonResponse({ count: 1 }));
    render(<NewMessageToast />);
    await poll();
    await poll();
    const toast = await screen.findByTestId("new-message-toast");
    expect(toast.textContent).toMatch(/New Teams message/);
    expect(toast.textContent).not.toMatch(/messages/);
  });

  test("renders nothing when count drops or stays the same", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkJsonResponse({ count: 5 }))
      .mockResolvedValueOnce(mkJsonResponse({ count: 5 }))
      .mockResolvedValueOnce(mkJsonResponse({ count: 2 }));
    render(<NewMessageToast />);
    await poll();
    await poll();
    await poll();
    expect(screen.queryByTestId("new-message-toast")).toBeNull();
  });

  test("click opens /messages + writes last_seen + clears toast", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkJsonResponse({ count: 0 }))
      .mockResolvedValueOnce(mkJsonResponse({ count: 2 }));
    render(<NewMessageToast />);
    await poll();
    await poll();
    const toast = await screen.findByTestId("new-message-toast");
    fireEvent.click(toast);
    expect(mockPush).toHaveBeenCalledWith("/messages");
    expect(window.localStorage.getItem("instinct.messages.last_seen")).toBeTruthy();
    await waitFor(() =>
      expect(screen.queryByTestId("new-message-toast")).toBeNull(),
    );
  });

  test("dismiss (✕) clears toast WITHOUT writing last_seen", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkJsonResponse({ count: 0 }))
      .mockResolvedValueOnce(mkJsonResponse({ count: 2 }));
    render(<NewMessageToast />);
    await poll();
    await poll();
    await screen.findByTestId("new-message-toast");
    fireEvent.click(screen.getByTestId("new-message-toast-dismiss"));
    expect(mockPush).not.toHaveBeenCalled();
    expect(window.localStorage.getItem("instinct.messages.last_seen")).toBeNull();
    await waitFor(() =>
      expect(screen.queryByTestId("new-message-toast")).toBeNull(),
    );
  });

  test("suppressed when scope_missing", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkJsonResponse({ count: 0 }))
      .mockResolvedValueOnce(mkJsonResponse({ count: 5, scope_missing: true }));
    render(<NewMessageToast />);
    await poll();
    await poll();
    expect(screen.queryByTestId("new-message-toast")).toBeNull();
  });

  test("suppressed when connected:false", async () => {
    mockFetchWithRefresh
      .mockResolvedValueOnce(mkJsonResponse({ count: 0 }))
      .mockResolvedValueOnce(mkJsonResponse({ count: 5, connected: false }));
    render(<NewMessageToast />);
    await poll();
    await poll();
    expect(screen.queryByTestId("new-message-toast")).toBeNull();
  });
});

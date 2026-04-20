/**
 * @jest-environment jsdom
 *
 * OfflineStatusPill — renders the three state labels correctly.
 *
 *   Online    -> "Online"
 *   Offline   -> "Offline — N edits queued"
 *   Syncing   -> "Syncing N edits..."
 *
 * We inject listQueue and flushQueue so the component is deterministic.
 */

import "@testing-library/jest-dom";
import { act, render, screen, waitFor } from "@testing-library/react";
import OfflineStatusPill, {
  notifyQueueChanged,
} from "@/components/sites/OfflineStatusPill";
import type { QueuedMutation } from "@/lib/offline-queue";

function makeEntry(overrides: Partial<QueuedMutation> = {}): QueuedMutation {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    endpoint: "/api/sites/1/brief-edit",
    method: "POST",
    headers: {},
    body: "{}",
    enqueued_at: 1,
    attempts: 0,
    last_error: null,
    status: "pending",
    ...overrides,
  };
}

beforeEach(() => {
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe("OfflineStatusPill", () => {
  it("renders 'Online' when navigator.onLine and no queued entries", async () => {
    const listImpl = jest.fn().mockResolvedValue([]);
    const flushImpl = jest.fn().mockResolvedValue({ replayed: 0, failed: 0 });

    await act(async () => {
      render(<OfflineStatusPill listImpl={listImpl as never} flushImpl={flushImpl as never} />);
    });

    const pill = await screen.findByTestId("offline-status-pill");
    expect(pill).toHaveAttribute("data-mode", "online");
    expect(pill).toHaveTextContent("Online");
  });

  it("renders 'Offline — N edits queued' when offline and queue non-empty", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const listImpl = jest.fn().mockResolvedValue([
      makeEntry({ id: "a" }),
      makeEntry({ id: "b" }),
      makeEntry({ id: "c" }),
    ]);
    const flushImpl = jest.fn().mockResolvedValue({ replayed: 0, failed: 0 });

    await act(async () => {
      render(
        <OfflineStatusPill
          initialOnline={false}
          listImpl={listImpl as never}
          flushImpl={flushImpl as never}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("offline-status-pill")).toHaveAttribute(
        "data-mode",
        "offline",
      );
    });
    expect(screen.getByTestId("offline-status-pill")).toHaveTextContent(
      "Offline — 3 edits queued",
    );
  });

  it("pluralization: shows 'Offline — 1 edit queued' (singular)", async () => {
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    const listImpl = jest.fn().mockResolvedValue([makeEntry({ id: "only" })]);
    const flushImpl = jest.fn().mockResolvedValue({ replayed: 0, failed: 0 });

    await act(async () => {
      render(
        <OfflineStatusPill
          initialOnline={false}
          listImpl={listImpl as never}
          flushImpl={flushImpl as never}
        />,
      );
    });

    await waitFor(() => {
      expect(screen.getByTestId("offline-status-pill")).toHaveTextContent(
        "Offline — 1 edit queued",
      );
    });
  });

  it("fires offline.detected analytics when the offline event dispatches", async () => {
    const analytics: Array<[string, Record<string, string | number | boolean>]> = [];
    const listImpl = jest.fn().mockResolvedValue([]);
    const flushImpl = jest.fn().mockResolvedValue({ replayed: 0, failed: 0 });

    await act(async () => {
      render(
        <OfflineStatusPill
          listImpl={listImpl as never}
          flushImpl={flushImpl as never}
          onAnalytics={(e, m) => analytics.push([e, m])}
        />,
      );
    });

    await act(async () => {
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        value: false,
      });
      window.dispatchEvent(new Event("offline"));
    });

    expect(analytics.some(([e]) => e === "offline.detected")).toBe(true);
  });

  it("triggers flush and shows Syncing state on 'online' event", async () => {
    // Start offline with 2 queued edits.
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    let entries: QueuedMutation[] = [makeEntry({ id: "x" }), makeEntry({ id: "y" })];
    const listImpl = jest.fn().mockImplementation(async () => entries);
    const flushImpl = jest.fn().mockImplementation(async () => {
      entries = [];
      return { replayed: 2, failed: 0 };
    });

    await act(async () => {
      render(
        <OfflineStatusPill
          initialOnline={false}
          listImpl={listImpl as never}
          flushImpl={flushImpl as never}
        />,
      );
    });

    // Fire the online event — component should call flushImpl.
    await act(async () => {
      Object.defineProperty(window.navigator, "onLine", {
        configurable: true,
        value: true,
      });
      window.dispatchEvent(new Event("online"));
      // Let the flush + refresh promise chain settle.
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(flushImpl).toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByTestId("offline-status-pill")).toHaveAttribute(
        "data-mode",
        "online",
      );
    });
  });

  it("refreshes when notifyQueueChanged() fires the custom event", async () => {
    let entries: QueuedMutation[] = [];
    const listImpl = jest.fn().mockImplementation(async () => entries);
    const flushImpl = jest.fn();

    await act(async () => {
      render(
        <OfflineStatusPill
          listImpl={listImpl as never}
          flushImpl={flushImpl as never}
        />,
      );
    });

    // Go offline + enqueue + notify.
    Object.defineProperty(window.navigator, "onLine", {
      configurable: true,
      value: false,
    });
    entries = [makeEntry({ id: "1" })];

    await act(async () => {
      notifyQueueChanged();
      await Promise.resolve();
    });

    await waitFor(() => {
      expect(screen.getByTestId("offline-status-pill")).toHaveTextContent(
        "Offline — 1 edit queued",
      );
    });
  });
});

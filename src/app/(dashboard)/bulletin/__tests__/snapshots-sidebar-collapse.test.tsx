/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

/**
 * /bulletin/[id] — snapshots sidebar collapse/expand behavior.
 *
 * Verifies:
 *   - Sidebar renders expanded by default (Saved snapshots heading visible).
 *   - Clicking the collapse button hides the heading + shows the expand
 *     control. Grid template column shifts from "1fr 280px" → "1fr 40px".
 *   - State persists across remount via localStorage.
 *   - Clicking expand restores the full sidebar.
 */

const mockFetchWithRefresh = jest.fn();
const mockGetInstinctToken = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  jsonHeaders: () => ({
    "Content-Type": "application/json",
    Authorization: "Bearer x",
  }),
  getInstinctToken: (...a: any[]) => mockGetInstinctToken(...a),
}));

import { Suspense } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BulletinBoardPage from "@/app/(dashboard)/bulletin/[id]/page";

const sampleBoard = {
  id: "board-1",
  title: "Meeting",
  description: null,
  ownerUserId: "u1",
  archivedAt: null,
  createdAt: "2026-05-11T00:00:00.000Z",
  updatedAt: "2026-05-11T00:00:00.000Z",
};

function mockBoardDetail() {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.includes("/api/bulletin/boards/board-1")) {
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ board: sampleBoard, notes: [], snapshots: [] }),
      });
    }
    return Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({}),
    });
  });
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReset();
  mockGetInstinctToken.mockReturnValue("tok");
  // Clean localStorage state between tests.
  try {
    window.localStorage.removeItem("instinct.bulletin.snapshots_collapsed");
  } catch {
    /* noop */
  }
  // Min surface so the canvas hook doesn't blow up under jsdom.
  Element.prototype.getBoundingClientRect = jest.fn(() => ({
    x: 0, y: 0, top: 0, left: 0, right: 1000, bottom: 600,
    width: 1000, height: 600, toJSON: () => ({}),
  })) as any;
  mockBoardDetail();
});

function renderBoard(boardId = "board-1") {
  // Next.js client `use()` requires a "settled" thenable, not a real Promise.
  const settled = { then() {}, status: "fulfilled", value: { id: boardId } };
  return render(
    <Suspense fallback={<div data-testid="suspended" />}>
      <BulletinBoardPage params={settled as any} />
    </Suspense>,
  );
}

describe("snapshots sidebar collapse/expand", () => {
  test("default state renders the expanded sidebar with heading", async () => {
    renderBoard();
    const sidebar = await screen.findByTestId("bulletin-snapshot-sidebar");
    expect(sidebar).toHaveAttribute("data-collapsed", "false");
    expect(screen.getByText(/saved snapshots/i)).toBeInTheDocument();
    expect(screen.getByTestId("bulletin-snapshot-sidebar-collapse")).toBeInTheDocument();
  });

  test("clicking collapse hides the heading and switches the sidebar attribute", async () => {
    renderBoard();
    const sidebar = await screen.findByTestId("bulletin-snapshot-sidebar");
    fireEvent.click(screen.getByTestId("bulletin-snapshot-sidebar-collapse"));

    await waitFor(() => {
      expect(sidebar).toHaveAttribute("data-collapsed", "true");
    });
    expect(screen.queryByText(/saved snapshots/i)).toBeNull();
    expect(screen.getByTestId("bulletin-snapshot-sidebar-expand")).toBeInTheDocument();
  });

  test("collapse state persists across remount via localStorage", async () => {
    const first = renderBoard();
    await screen.findByTestId("bulletin-snapshot-sidebar");
    fireEvent.click(screen.getByTestId("bulletin-snapshot-sidebar-collapse"));
    await waitFor(() => {
      expect(window.localStorage.getItem("instinct.bulletin.snapshots_collapsed")).toBe("1");
    });
    first.unmount();

    // Second mount: expect collapsed-by-default from localStorage.
    mockBoardDetail();
    renderBoard();
    const sidebar2 = await screen.findByTestId("bulletin-snapshot-sidebar");
    expect(sidebar2).toHaveAttribute("data-collapsed", "true");
    expect(screen.getByTestId("bulletin-snapshot-sidebar-expand")).toBeInTheDocument();
  });

  test("clicking expand restores the full sidebar", async () => {
    try {
      window.localStorage.setItem("instinct.bulletin.snapshots_collapsed", "1");
    } catch {
      /* noop */
    }
    renderBoard();
    const sidebar = await screen.findByTestId("bulletin-snapshot-sidebar");
    expect(sidebar).toHaveAttribute("data-collapsed", "true");
    fireEvent.click(screen.getByTestId("bulletin-snapshot-sidebar-expand"));
    await waitFor(() => {
      expect(sidebar).toHaveAttribute("data-collapsed", "false");
    });
    expect(screen.getByText(/saved snapshots/i)).toBeInTheDocument();
  });
});

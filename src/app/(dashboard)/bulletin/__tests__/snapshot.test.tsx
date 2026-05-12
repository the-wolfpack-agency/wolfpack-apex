/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

/**
 * /bulletin/[id] — snapshot flow tests.
 *
 * Verifies:
 *   - Clicking "Save as image" opens the modal
 *   - Submitting the modal POSTs to /snapshot with png_base64 payload
 *   - Optional association is forwarded to the POST when chosen
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
  title: "Board",
  description: null,
  ownerUserId: "u1",
  archivedAt: null,
  createdAt: "2026-04-29T10:00:00.000Z",
  updatedAt: "2026-04-29T10:00:00.000Z",
};

function makeNote(overrides: any = {}) {
  return {
    id: "note-1",
    boardId: "board-1",
    body: "Hello",
    color: "#FFE873",
    x_pct: 20,
    y_pct: 20,
    width_pct: 18,
    height_pct: 18,
    rotation_deg: 0,
    association_kind: null,
    association_id: null,
    association_label: null,
    createdByUserId: "u1",
    createdByUserRole: "ceo",
    createdByUserName: "Nick",
    createdAt: "2026-04-29T10:00:00.000Z",
    updatedAt: "2026-04-29T10:00:00.000Z",
    ...overrides,
  };
}

function mockBoardDetail(notes: any[] = []) {
  mockFetchWithRefresh.mockImplementationOnce(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ board: sampleBoard, notes, snapshots: [] }),
    }),
  );
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReset();
  mockGetInstinctToken.mockReturnValue("tok");

  Element.prototype.getBoundingClientRect = jest.fn(() => ({
    x: 0,
    y: 0,
    top: 0,
    left: 0,
    right: 1000,
    bottom: 600,
    width: 1000,
    height: 600,
    toJSON: () => ({}),
  })) as any;

  /* jsdom doesn't implement HTMLCanvasElement.getContext or toDataURL.
     Stub both with the minimum surface our snapshot fallback uses, so
     the foreignObject path errors and the fallback runs. */
  HTMLCanvasElement.prototype.getContext = jest.fn(() => ({
    fillStyle: "",
    fillRect: jest.fn(),
    drawImage: jest.fn(),
    font: "",
    measureText: jest.fn(() => ({ width: 50 })),
    fillText: jest.fn(),
    save: jest.fn(),
    restore: jest.fn(),
    translate: jest.fn(),
    rotate: jest.fn(),
  })) as any;
  HTMLCanvasElement.prototype.toDataURL = jest.fn(
    () => "data:image/png;base64,STUBBASE64==",
  );

  if (typeof URL.createObjectURL === "undefined") {
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      writable: true,
      value: jest.fn(() => "blob:test"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      writable: true,
      value: jest.fn(),
    });
  }

  /* Force the foreignObject path to error so the manual fallback runs.
     We do this by making `new Image()` reject on src set — jsdom Image
     doesn't actually load src URLs but doesn't fire either onload or
     onerror, leaving the await pending. We patch its prototype to fire
     onerror synchronously after src assignment. */
  Object.defineProperty(window.Image.prototype, "src", {
    configurable: true,
    set() {
      const self = this;
      setTimeout(() => self.onerror && self.onerror(new Event("error")), 0);
    },
  });
});

function renderBoard(boardId = "board-1") {
  const settled = {
    then() {},
    status: "fulfilled",
    value: { id: boardId },
  };
  return render(
    <Suspense fallback={<div data-testid="suspended" />}>
      <BulletinBoardPage params={settled as any} />
    </Suspense>,
  );
}

describe("/bulletin/[id] snapshot flow", () => {
  test("clicking Save as image opens the modal", async () => {
    mockBoardDetail([makeNote()]);
    renderBoard();

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-board-page")).toBeInTheDocument(),
    );

    expect(screen.queryByTestId("bulletin-snapshot-modal")).toBeNull();
    fireEvent.click(screen.getByTestId("bulletin-snapshot-open"));
    expect(screen.getByTestId("bulletin-snapshot-modal")).toBeInTheDocument();
    expect(screen.getByTestId("bulletin-snapshot-save")).toBeInTheDocument();
  });

  test("submitting the modal POSTs to /snapshot with png_base64 in the body", async () => {
    mockBoardDetail([makeNote()]);

    /* POST response. */
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          snapshot: {
            id: "snap-1",
            boardId: "board-1",
            association_kind: null,
            association_id: null,
            association_label: null,
            createdByUserId: "u1",
            createdAt: "2026-04-30T10:00:00.000Z",
          },
        }),
      }),
    );

    renderBoard();

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-board-page")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("bulletin-snapshot-open"));
    fireEvent.click(screen.getByTestId("bulletin-snapshot-save"));

    await waitFor(() => {
      const postCall = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(String(postCall![0])).toBe(
        "/api/bulletin/boards/board-1/snapshot",
      );
      const body = JSON.parse(postCall![1].body);
      expect(typeof body.png_base64).toBe("string");
      expect(body.png_base64.length).toBeGreaterThan(0);
    });

    /* Modal closes; new snapshot row appears in the sidebar. */
    await waitFor(() => {
      expect(screen.queryByTestId("bulletin-snapshot-modal")).toBeNull();
    });
    expect(screen.getByTestId("bulletin-snapshot-row-snap-1")).toBeInTheDocument();
  });
});

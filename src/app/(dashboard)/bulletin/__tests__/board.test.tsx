/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

/**
 * /bulletin/[id] tests.
 *
 * Covers:
 *   - Loads board detail and renders existing notes
 *   - Add note posts and the new note appears
 *   - Drag updates x_pct/y_pct via PATCH
 *   - Color change PATCHes
 *   - Delete soft-removes the note from the canvas
 *   - Association dropdown reads endpoint list and writes via PATCH
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
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import BulletinBoardPage from "@/app/(dashboard)/bulletin/[id]/page";

const sampleBoard = {
  id: "board-1",
  title: "Q3 Retro",
  description: "what worked",
  ownerUserId: "u1",
  archivedAt: null,
  createdAt: "2026-04-29T10:00:00.000Z",
  updatedAt: "2026-04-29T10:00:00.000Z",
};

function makeNote(overrides: Partial<any> = {}) {
  return {
    id: "note-1",
    boardId: "board-1",
    body: "Hello world",
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

function mockBoardDetail(notes: any[] = [], snapshots: any[] = []) {
  mockFetchWithRefresh.mockImplementationOnce(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ board: sampleBoard, notes, snapshots }),
    }),
  );
}

/* React's `use(params)` accepts a thenable. We synthesize a pre-settled
   one so the page reads params synchronously — a fresh Promise causes
   `use` to suspend on first render and our test never advances. */
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

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReset();
  mockGetInstinctToken.mockReturnValue("tok");
  /* Stub getBoundingClientRect on the canvas so drag math has a real
     viewport. jsdom returns zeros by default which would zero-out our
     percentage delta. */
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
});

afterEach(() => {
  jest.useRealTimers();
});

describe("/bulletin/[id]", () => {
  test("loads detail and renders existing notes", async () => {
    mockBoardDetail([makeNote(), makeNote({ id: "note-2", body: "Two" })]);

    renderBoard();

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-board-page")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("bulletin-note-note-1")).toBeInTheDocument();
    expect(screen.getByTestId("bulletin-note-note-2")).toBeInTheDocument();
    /* Title input prefilled with the board title. */
    expect(screen.getByTestId("bulletin-board-title-input")).toHaveValue(
      "Q3 Retro",
    );
  });

  test("add note posts to /notes and appends the returned note to the canvas", async () => {
    mockBoardDetail([]);
    /* POST response. */
    const newNote = makeNote({ id: "note-new", body: "" });
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ note: newNote }),
      }),
    );

    renderBoard();

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-board-page")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("bulletin-add-note"));
    /* Pick a color */
    fireEvent.click(screen.getByTestId("bulletin-add-note-color-#FFE873"));

    await waitFor(() => {
      const postCall = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(String(postCall![0])).toBe(
        "/api/bulletin/boards/board-1/notes",
      );
      const body = JSON.parse(postCall![1].body);
      expect(body.color).toBe("#FFE873");
      expect(body.position).toBeTruthy();
    });

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-note-note-new")).toBeInTheDocument(),
    );
  });

  test("dragging a note updates position via debounced PATCH", async () => {
    jest.useFakeTimers();
    mockBoardDetail([makeNote()]);
    /* PATCH for the drag debounce. */
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ note: makeNote({ x_pct: 30, y_pct: 30 }) }),
      }),
    );

    renderBoard();

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-note-note-1")).toBeInTheDocument(),
    );

    const note = screen.getByTestId("bulletin-note-note-1");
    /* Begin drag */
    fireEvent.pointerDown(note, { clientX: 200, clientY: 120 });
    /* Move — jsdom doesn't ship PointerEvent. The handler in the page
       listens via window.addEventListener("pointermove", ...), which
       in real browsers receives PointerEvent objects. We fake one with
       a MouseEvent (same .clientX/.clientY surface) and dispatch it
       under the "pointermove" type so the listener fires. */
    act(() => {
      const moveEv = new MouseEvent("pointermove", {
        clientX: 300,
        clientY: 180,
        bubbles: true,
      });
      window.dispatchEvent(moveEv);
    });
    /* End */
    act(() => {
      const upEv = new MouseEvent("pointerup", { bubbles: true });
      window.dispatchEvent(upEv);
    });

    /* Flush the debounce. */
    act(() => {
      jest.advanceTimersByTime(250);
    });

    await waitFor(() => {
      const patchCall = mockFetchWithRefresh.mock.calls.find(
        (c) =>
          c[1]?.method === "PATCH" &&
          String(c[0]).includes("/api/bulletin/notes/note-1"),
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall![1].body);
      expect(typeof body.x_pct).toBe("number");
      expect(typeof body.y_pct).toBe("number");
    });
  });

  test("color change PATCHes the note", async () => {
    mockBoardDetail([makeNote()]);
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ note: makeNote({ color: "#B6E3FF" }) }),
      }),
    );

    renderBoard();

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-note-note-1")).toBeInTheDocument(),
    );

    /* Open palette on the note. */
    fireEvent.click(screen.getByTestId("bulletin-note-color-toggle-note-1"));
    fireEvent.click(
      screen.getByTestId("bulletin-note-color-note-1-#B6E3FF"),
    );

    await waitFor(() => {
      const patchCall = mockFetchWithRefresh.mock.calls.find(
        (c) =>
          c[1]?.method === "PATCH" &&
          String(c[0]).includes("/api/bulletin/notes/note-1"),
      );
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall![1].body);
      expect(body.color).toBe("#B6E3FF");
    });
  });

  test("delete removes the note from the canvas", async () => {
    mockBoardDetail([makeNote()]);
    mockFetchWithRefresh.mockImplementation(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ ok: true }),
      }),
    );

    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId("bulletin-note-note-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("bulletin-note-delete-note-1"));

    await waitFor(() => {
      const deleteCall = mockFetchWithRefresh.mock.calls.find(
        (c) =>
          c[1]?.method === "DELETE" &&
          String(c[0]).includes("/api/bulletin/notes/note-1"),
      );
      expect(deleteCall).toBeTruthy();
    });

    await waitFor(() => {
      expect(screen.queryByTestId("bulletin-note-note-1")).toBeNull();
    });
  });

  test("association dropdown reads task list endpoint and PATCHes association on selection", async () => {
    mockBoardDetail([makeNote()]);

    /* Open the assoc panel on the note → choose "task" → endpoint
       /api/tasks?limit=50 fires → we resolve with two tasks → user
       picks one → PATCH fires.

       PATCH responses echo the patch body back so optimistic state in
       the page survives the re-merge from the server response. */
    mockFetchWithRefresh.mockImplementation((url: string, init?: any) => {
      if (typeof url === "string" && url.startsWith("/api/tasks")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            tasks: [
              { id: "t1", title: "Buy milk" },
              { id: "t2", title: "Ship feature" },
            ],
          }),
        });
      }
      if (init?.method === "PATCH") {
        const patch =
          typeof init.body === "string" ? JSON.parse(init.body) : {};
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ note: makeNote(patch) }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });

    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId("bulletin-note-note-1")).toBeInTheDocument(),
    );

    /* Open the assoc panel. */
    fireEvent.click(screen.getByTestId("bulletin-note-assoc-toggle-note-1"));

    /* Select "task" as the kind. */
    const kindSelect = screen.getByTestId(
      "bulletin-note-assoc-note-1-kind",
    );
    fireEvent.change(kindSelect, { target: { value: "task" } });

    /* The id picker appears once the list resolves. */
    const idSelect = await screen.findByTestId(
      "bulletin-note-assoc-note-1-id",
    );
    fireEvent.change(idSelect, { target: { value: "t1" } });

    await waitFor(() => {
      /* Find the PATCH call that actually carries the resolved id —
         we expect at least one PATCH after the user picks "t1" (the
         earlier kind-only PATCH set the kind with empty id). */
      const patchCall = mockFetchWithRefresh.mock.calls.find((c) => {
        if (
          c[1]?.method !== "PATCH" ||
          !String(c[0]).includes("/api/bulletin/notes/note-1")
        )
          return false;
        try {
          const body = JSON.parse(c[1].body);
          return body.association_id === "t1";
        } catch {
          return false;
        }
      });
      expect(patchCall).toBeTruthy();
      const body = JSON.parse(patchCall![1].body);
      expect(body.association_kind).toBe("task");
      expect(body.association_id).toBe("t1");
      expect(body.association_label).toBe("Buy milk");
    });
  });

  test("association picker falls back to manual id+label when endpoint 404s", async () => {
    mockBoardDetail([makeNote()]);

    mockFetchWithRefresh.mockImplementation((url: string, init?: any) => {
      if (typeof url === "string" && url.startsWith("/api/tasks")) {
        return Promise.resolve({
          ok: false,
          status: 404,
          json: async () => ({ error: "not found" }),
        });
      }
      if (init?.method === "PATCH") {
        const patch =
          typeof init.body === "string" ? JSON.parse(init.body) : {};
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ note: makeNote(patch) }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({}),
      });
    });

    renderBoard();
    await waitFor(() =>
      expect(screen.getByTestId("bulletin-note-note-1")).toBeInTheDocument(),
    );

    fireEvent.click(screen.getByTestId("bulletin-note-assoc-toggle-note-1"));

    fireEvent.change(
      screen.getByTestId("bulletin-note-assoc-note-1-kind"),
      { target: { value: "task" } },
    );

    /* Manual fallback inputs appear. */
    await screen.findByTestId("bulletin-note-assoc-note-1-manual");
    expect(
      screen.getByTestId("bulletin-note-assoc-note-1-manual-id"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("bulletin-note-assoc-note-1-manual-label"),
    ).toBeInTheDocument();
  });
});

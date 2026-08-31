/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

/**
 * /bulletin index page tests.
 *
 * Locks:
 *   - Loading skeleton when no token (auth-gate path)
 *   - Lists boards from GET /api/bulletin/boards
 *   - Submitting create form posts the body and prepends the new board
 *   - Empty state renders when boards: []
 *   - Archived section toggles
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

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import BulletinIndexPage from "@/app/(dashboard)/bulletin/page";

const boardA = {
  id: "board-1",
  title: "Q3 Retro",
  description: "what worked, what didn't",
  ownerUserId: "u1",
  archivedAt: null,
  createdAt: "2026-04-29T10:00:00.000Z",
  updatedAt: "2026-04-29T11:00:00.000Z",
};

const boardB = {
  id: "board-2",
  title: "Marketing brainstorm",
  description: null,
  ownerUserId: "u1",
  archivedAt: null,
  createdAt: "2026-04-28T10:00:00.000Z",
  updatedAt: "2026-04-28T10:00:00.000Z",
};

const boardArchived = {
  id: "board-3",
  title: "Old launch",
  description: null,
  ownerUserId: "u1",
  archivedAt: "2026-04-25T10:00:00.000Z",
  createdAt: "2026-04-01T10:00:00.000Z",
  updatedAt: "2026-04-25T10:00:00.000Z",
};

function mockListResponse(boards: unknown[]) {
  mockFetchWithRefresh.mockImplementationOnce(() =>
    Promise.resolve({
      ok: true,
      status: 200,
      json: async () => ({ boards }),
    }),
  );
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
  mockGetInstinctToken.mockReset();
  mockGetInstinctToken.mockReturnValue("tok");
});

describe("/bulletin index", () => {
  test("redirect path: when no token, only the loading skeleton renders and no API call fires", async () => {
    mockGetInstinctToken.mockReturnValue(null);

    render(<BulletinIndexPage />);

    await waitFor(() => {
      expect(mockGetInstinctToken).toHaveBeenCalled();
    });
    expect(screen.getByTestId("bulletin-page-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("bulletin-page")).toBeNull();
    expect(mockFetchWithRefresh).not.toHaveBeenCalled();
  });

  test("renders boards from GET /api/bulletin/boards", async () => {
    mockListResponse([boardA, boardB, boardArchived]);

    render(<BulletinIndexPage />);

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-page")).toBeInTheDocument(),
    );

    /* Active boards rendered. */
    await waitFor(() =>
      expect(screen.getByTestId("bulletin-row-board-1")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("bulletin-row-board-2")).toBeInTheDocument();

    /* Archived board is NOT in the active list. */
    expect(screen.queryByTestId("bulletin-row-board-3")).toBeNull();

    /* GET fired with the right URL. */
    const getCall = mockFetchWithRefresh.mock.calls[0];
    expect(String(getCall[0])).toBe("/api/bulletin/boards");
  });

  test("empty state when GET returns []", async () => {
    mockListResponse([]);

    render(<BulletinIndexPage />);

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-list-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("bulletin-list")).toBeNull();
  });

  test("submitting the create form POSTs the body and prepends the new board", async () => {
    mockListResponse([boardB]);

    const newBoard = { ...boardA, id: "board-new", title: "New idea" };
    /* POST response. */
    mockFetchWithRefresh.mockImplementationOnce(() =>
      Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ board: newBoard }),
      }),
    );

    render(<BulletinIndexPage />);

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-create-form")).toBeInTheDocument(),
    );

    fireEvent.change(screen.getByTestId("bulletin-create-title"), {
      target: { value: "New idea" },
    });
    fireEvent.change(screen.getByTestId("bulletin-create-description"), {
      target: { value: "A description" },
    });
    fireEvent.click(screen.getByTestId("bulletin-create-submit"));

    await waitFor(() => {
      const postCall = mockFetchWithRefresh.mock.calls.find(
        (c) => c[1]?.method === "POST",
      );
      expect(postCall).toBeTruthy();
      expect(String(postCall![0])).toBe("/api/bulletin/boards");
      const body = JSON.parse(postCall![1].body);
      expect(body.title).toBe("New idea");
      expect(body.description).toBe("A description");
    });

    /* The handler optimiztically prepends the new board to the in-memory
       list and then triggers a navigation. We assert the prepend; the
       navigation itself isn't testable in jsdom (Location.href setter
       throws "Not implemented: navigation") and is left to E2E. */
    await waitFor(() =>
      expect(screen.getByTestId("bulletin-row-board-new")).toBeInTheDocument(),
    );
  });

  test("create form blocks empty title", async () => {
    mockListResponse([]);

    render(<BulletinIndexPage />);
    await waitFor(() =>
      expect(screen.getByTestId("bulletin-create-form")).toBeInTheDocument(),
    );

    /* Submitting without a title should not POST. The HTML required
       attribute will block in real browsers; we directly verify by
       firing submit on the form to exercise our handler's guard. */
    const form = screen.getByTestId("bulletin-create-form");
    fireEvent.submit(form);

    const postCalls = mockFetchWithRefresh.mock.calls.filter(
      (c) => c[1]?.method === "POST",
    );
    expect(postCalls).toHaveLength(0);
  });

  test("archived section toggles open and reveals archived boards", async () => {
    mockListResponse([boardA, boardArchived]);

    render(<BulletinIndexPage />);

    await waitFor(() =>
      expect(screen.getByTestId("bulletin-row-board-1")).toBeInTheDocument(),
    );

    /* Initially collapsed: no archived list. */
    expect(screen.queryByTestId("bulletin-archived-list")).toBeNull();

    fireEvent.click(screen.getByTestId("bulletin-archived-toggle"));

    /* Expanded: row appears. */
    await waitFor(() =>
      expect(
        screen.getByTestId("bulletin-archived-row-board-3"),
      ).toBeInTheDocument(),
    );
  });
});

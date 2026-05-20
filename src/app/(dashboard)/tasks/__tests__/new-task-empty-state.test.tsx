/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * "New task" modal — empty-state behavior.
 *
 * Shipped 2026-05-20 after a Safari user reported the list dropdown
 * rendered as a blank box, blocking task creation. Root cause: when
 * the MS Graph sync hadn't been run, `lists` was empty and the
 * <select> rendered with zero options — Safari shows that as a blank
 * field (Chrome usually shows the first option as a label). The fix:
 * detect the empty-list state, surface a clear cause, give a Sync
 * action inline, and disable the Create button.
 */

const mockFetchWithRefresh = jest.fn();
const mockJsonHeaders = jest.fn(() => ({ "Content-Type": "application/json" }));
const mockAuthHeaders = jest.fn(() => ({ Authorization: "Bearer test" }));

jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
  jsonHeaders: () => mockJsonHeaders(),
  authHeaders: () => mockAuthHeaders(),
}));

import { act, render, screen, fireEvent, waitFor } from "@testing-library/react";
import TasksPage from "@/app/(dashboard)/tasks/page";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return {
    ok: opts.ok ?? true,
    status: opts.status ?? 200,
    json: async () => body,
  };
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("/tasks — New task empty-list state", () => {
  it("surfaces a clear message + Sync button when lists is empty", async () => {
    /* Initial loads: lists empty, tasks empty, MS connected. */
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/tasks/lists") return mkRes({ lists: [] });
      if (url.startsWith("/api/tasks?") || url === "/api/tasks") return mkRes({ tasks: [] });
      if (url === "/api/integrations/status") return mkRes({ microsoft: { connected: true } });
      return mkRes({});
    });

    await act(async () => {
      render(<TasksPage />);
    });

    /* Wait for MS status to resolve as connected so the page renders
       the main view rather than the "connect MS" guard. */
    const newButton = await screen.findByText("+ New task", undefined, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(newButton);
    });

    await waitFor(() => expect(screen.getByTestId("new-task-no-lists")).toBeInTheDocument());
    expect(screen.getByTestId("new-task-sync")).toBeInTheDocument();
    /* The plain <select> must be hidden when no lists are available
       (it would otherwise render blank in Safari). */
    expect(screen.queryByTestId("new-task-list-select")).not.toBeInTheDocument();
    /* Create must be disabled. */
    const createBtn = screen.getByTestId("new-task-create");
    expect(createBtn).toBeDisabled();
  });

  it("renders the list select with a placeholder option when lists exist", async () => {
    const sampleList = { id: "l1", msListId: "ms-l1", displayName: "Tasks" };
    mockFetchWithRefresh.mockImplementation(async (url: string) => {
      if (url === "/api/tasks/lists") return mkRes({ lists: [sampleList] });
      if (url.startsWith("/api/tasks?") || url === "/api/tasks") return mkRes({ tasks: [] });
      if (url === "/api/integrations/status") return mkRes({ microsoft: { connected: true } });
      return mkRes({});
    });
    await act(async () => {
      render(<TasksPage />);
    });
    const newButton = await screen.findByText("+ New task", undefined, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(newButton);
    });
    const select = await screen.findByTestId("new-task-list-select");
    /* Verify the placeholder option is the first child — Safari's
       blank-select bug is fixed by having a disabled placeholder. */
    const firstOption = select.querySelector("option");
    expect(firstOption?.textContent).toMatch(/Choose a list/i);
    /* And the real list is also rendered. */
    expect(select).toHaveTextContent("Tasks");
  });

  it("clicking Sync calls /api/tasks/sync and surfaces an error if the sync fails", async () => {
    mockFetchWithRefresh.mockImplementation(async (url: string, opts?: { method?: string }) => {
      if (url === "/api/tasks/lists") return mkRes({ lists: [] });
      if (url.startsWith("/api/tasks?") || url === "/api/tasks") return mkRes({ tasks: [] });
      if (url === "/api/integrations/status") return mkRes({ microsoft: { connected: true } });
      if (url === "/api/tasks/sync" && opts?.method === "POST") {
        return mkRes({ error: "scope_missing" }, { ok: false, status: 403 });
      }
      return mkRes({});
    });
    await act(async () => {
      render(<TasksPage />);
    });
    const newButton = await screen.findByText("+ New task", undefined, { timeout: 3_000 });
    await act(async () => {
      fireEvent.click(newButton);
    });
    const syncBtn = await screen.findByTestId("new-task-sync");
    await act(async () => {
      fireEvent.click(syncBtn);
    });
    await waitFor(() =>
      expect(screen.getByTestId("new-task-error")).toHaveTextContent(/scope_missing/i),
    );
  });
});

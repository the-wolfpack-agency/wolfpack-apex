/**
 * @jest-environment jsdom
 */

/**
 * Tasks UI tests — three status columns, optimistic complete, search,
 * sync button, empty state when MS not connected.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor, act } from "@testing-library/react";

jest.mock("@/lib/client-auth", () => ({
  authHeaders: () => ({ Authorization: "Bearer test-token" }),
  jsonHeaders: () => ({ Authorization: "Bearer test-token", "Content-Type": "application/json" }),
  fetchWithRefresh: jest.fn((url, opts) => fetch(url, opts)), fetchJsonWithRefresh: jest.fn(async (url, opts) => (await fetch(url, opts)).json()) }));

const fetchMock = jest.fn();

beforeAll(() => {
  global.fetch = fetchMock as unknown as typeof fetch;
});

function mkRes(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
  });
}

const LIST = { id: "list-uuid", msListId: "ms-list-1", displayName: "Tasks" };
const TASKS = [
  { id: "t1", msTaskId: "m1", listId: "list-uuid", title: "Open item", body: null,
    status: "notStarted", importance: "normal", dueAt: null, completedAt: null },
  { id: "t2", msTaskId: "m2", listId: "list-uuid", title: "Active item", body: null,
    status: "inProgress", importance: "high", dueAt: null, completedAt: null },
  { id: "t3", msTaskId: "m3", listId: "list-uuid", title: "Done item", body: null,
    status: "completed", importance: "normal", dueAt: null, completedAt: null },
];

function defaultFetch(url: string, init?: RequestInit) {
  if (url.startsWith("/api/integrations/status")) {
    return mkRes({ microsoft: { connected: true } });
  }
  if (url.startsWith("/api/tasks/lists")) {
    return mkRes({ lists: [LIST] });
  }
  if (url === "/api/tasks/sync" || url.startsWith("/api/tasks/sync")) {
    return mkRes({ listCount: 1, taskCount: 3, durationMs: 10 });
  }
  if (url.startsWith("/api/tasks/") && url.endsWith("/complete")) {
    return mkRes({ task: { ...TASKS[0], status: "completed" } });
  }
  if (url.startsWith("/api/tasks")) {
    // GET list
    if (!init || init.method === undefined || init.method === "GET") {
      return mkRes({ tasks: TASKS, nextCursor: null });
    }
  }
  return Promise.reject(new Error(`Unmocked fetch: ${url}`));
}

beforeEach(() => {
  fetchMock.mockReset();
  fetchMock.mockImplementation(defaultFetch);
});

import TasksPage from "@/app/(dashboard)/tasks/page";

describe("Tasks page", () => {
  it("shows empty state when MS not connected", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/integrations/status")) {
        return mkRes({ microsoft: { connected: false } });
      }
      return defaultFetch(url);
    });
    await act(async () => {
      render(<TasksPage />);
    });
    await waitFor(() => {
      expect(screen.getByText(/Connect Microsoft To Do in Settings/i)).toBeInTheDocument();
    });
  });

  it("renders three status tabs and filters by active tab", async () => {
    await act(async () => {
      render(<TasksPage />);
    });
    await waitFor(() => expect(screen.getByRole("tab", { name: "Open" })).toBeInTheDocument());
    // Open tab is default — shows notStarted item
    expect(screen.getByText("Open item")).toBeInTheDocument();
    // Completed tab is rendered but its content is filtered out by default
    expect(screen.queryByText("Done item")).not.toBeInTheDocument();

    // Click In Progress tab
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "In Progress" }));
    });
    expect(screen.getByText("Active item")).toBeInTheDocument();
    expect(screen.queryByText("Open item")).not.toBeInTheDocument();

    // Click Completed tab
    await act(async () => {
      fireEvent.click(screen.getByRole("tab", { name: "Completed" }));
    });
    expect(screen.getByText("Done item")).toBeInTheDocument();
  });

  it("optimistically completes a task via checkbox + calls complete API", async () => {
    await act(async () => {
      render(<TasksPage />);
    });
    await waitFor(() => expect(screen.getByText("Open item")).toBeInTheDocument());

    const checkbox = screen.getByLabelText("Complete Open item") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      fireEvent.click(checkbox);
    });
    // Optimistic update fires the complete call
    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringMatching(/^\/api\/tasks\/t1\/complete$/),
        expect.objectContaining({ method: "POST" }),
      );
    });
  });

  it("search input updates query string on API call", async () => {
    await act(async () => {
      render(<TasksPage />);
    });
    await waitFor(() => expect(screen.getByText("Open item")).toBeInTheDocument());
    const input = screen.getByPlaceholderText("Search");
    await act(async () => {
      fireEvent.change(input, { target: { value: "memo" } });
    });
    await waitFor(() => {
      const hit = fetchMock.mock.calls.find((c: unknown[]) =>
        typeof c[0] === "string" && c[0].includes("/api/tasks?") && c[0].includes("search=memo"),
      );
      expect(hit).toBeTruthy();
    });
  });

  it("Sync now button triggers sync + refetch", async () => {
    await act(async () => {
      render(<TasksPage />);
    });
    await waitFor(() => expect(screen.getByText("Open item")).toBeInTheDocument());
    const btn = screen.getByText("Sync now");
    fetchMock.mockClear();
    fetchMock.mockImplementation(defaultFetch);
    await act(async () => {
      fireEvent.click(btn);
    });
    await waitFor(() => {
      const syncCall = fetchMock.mock.calls.find((c: unknown[]) => c[0] === "/api/tasks/sync");
      expect(syncCall).toBeTruthy();
    });
    // After sync, list refetched
    await waitFor(() => {
      const listCall = fetchMock.mock.calls.find((c: unknown[]) =>
        typeof c[0] === "string" && c[0].startsWith("/api/tasks") && !String(c[0]).includes("/sync"),
      );
      expect(listCall).toBeTruthy();
    });
  });
});

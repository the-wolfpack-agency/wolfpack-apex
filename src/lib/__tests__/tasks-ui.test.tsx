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
    const m = init?.method;
    if (!m || m === "GET") return mkRes({ tasks: TASKS, nextCursor: null });
    if (m === "PATCH") return mkRes({ task: TASKS[0] });
    if (m === "DELETE") return mkRes({ ok: true });
    if (m === "POST") return mkRes({ task: TASKS[0] }, 201);
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

  it("optimistically completes a task via checkbox + PATCHes status=completed", async () => {
    await act(async () => {
      render(<TasksPage />);
    });
    await waitFor(() => expect(screen.getByText("Open item")).toBeInTheDocument());

    const checkbox = screen.getByLabelText("Complete Open item") as HTMLInputElement;
    expect(checkbox.checked).toBe(false);

    await act(async () => {
      fireEvent.click(checkbox);
    });
    // Complete-toggle now uses PATCH /api/tasks/:id with status body so
    // the same code path can un-complete too (see next test).
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          /^\/api\/tasks\/t1$/.test(c[0] as string) &&
          (c[1] as RequestInit)?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch![1] as RequestInit).body as string);
      expect(body.status).toBe("completed");
    });
  });

  it("unchecks a completed task to re-open it (Outlook parity)", async () => {
    // The checkbox on the Completed tab must PATCH status=notStarted
    // so Outlook-style re-open behavior works.
    await act(async () => {
      render(<TasksPage />);
    });
    await waitFor(() => expect(screen.getByText("Open item")).toBeInTheDocument());
    // Switch to Completed tab so the "Done item" renders.
    fireEvent.click(screen.getByRole("tab", { name: "Completed" }));
    await waitFor(() => expect(screen.getByText("Done item")).toBeInTheDocument());

    const reopen = screen.getByLabelText("Reopen Done item") as HTMLInputElement;
    expect(reopen.checked).toBe(true);
    await act(async () => {
      fireEvent.click(reopen);
    });
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c: unknown[]) =>
          typeof c[0] === "string" &&
          /^\/api\/tasks\/t3$/.test(c[0] as string) &&
          (c[1] as RequestInit)?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      const body = JSON.parse((patch![1] as RequestInit).body as string);
      expect(body.status).toBe("notStarted");
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

  it("New Task modal hides read-only lists (Flagged Emails) from the target dropdown", async () => {
    // The read-only "Flagged Emails" list Graph accepts writes for but
    // does not show in Microsoft To Do — users picked it and thought
    // their tasks disappeared. The modal must filter it out.
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url.startsWith("/api/integrations/status")) {
        return mkRes({ microsoft: { connected: true } });
      }
      if (url.startsWith("/api/tasks/lists")) {
        return mkRes({
          lists: [
            { id: "l1", msListId: "ms-1", displayName: "Flagged Emails" },
            { id: "l2", msListId: "ms-2", displayName: "Tasks" },
          ],
        });
      }
      if (url.startsWith("/api/tasks")) {
        if (!init || init.method === undefined || init.method === "GET") {
          return mkRes({ tasks: [], nextCursor: null });
        }
      }
      return mkRes({}, 404);
    });

    const { default: TasksPage } = await import("@/app/(dashboard)/tasks/page");
    render(<TasksPage />);
    await waitFor(() =>
      expect(fetchMock.mock.calls.some((c: unknown[]) => String(c[0]).startsWith("/api/tasks/lists"))).toBe(true),
    );
    fireEvent.click(screen.getByText("+ New task"));
    const modalDialog = await screen.findByRole("dialog", { name: "New task" });
    // Dropdown under the modal should not list "Flagged Emails" as an option
    const options = Array.from(modalDialog.querySelectorAll("option")).map(
      (o) => o.textContent,
    );
    expect(options).toContain("Tasks");
    expect(options).not.toContain("Flagged Emails");
  });
});

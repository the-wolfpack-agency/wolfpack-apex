/**
 * @jest-environment jsdom
 *
 * TaskListWidget — DOM render + check-off flow + analytics + empty
 * state + due-date formatting.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) => mockFetch(...a),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { TaskListWidget } from "@/components/widgets/TaskListWidget";
import type { TaskListWidgetSpec } from "@/lib/assistant/widgets/types";

const past = new Date(Date.now() - 86400000).toISOString();
const future = new Date(Date.now() + 86400000).toISOString();

const spec: TaskListWidgetSpec = {
  kind: "task_list",
  title: "Open tasks",
  subtitle: "2 open · 1 overdue",
  tasks: [
    {
      id: "t1",
      title: "File Q3 expenses",
      status: "notStarted",
      importance: "high",
      dueAt: past,
      listId: "l1",
    },
    {
      id: "t2",
      title: "Review pull requests",
      status: "inProgress",
      importance: "normal",
      dueAt: future,
      listId: "l1",
    },
  ],
};

beforeEach(() => {
  mockFetch.mockReset();
  /* Default to a success response — analytics calls always succeed,
   * complete-task overridden per test. */
  mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
});

describe("TaskListWidget", () => {
  test("renders title + subtitle + each task row", () => {
    render(<TaskListWidget spec={spec} />);
    expect(screen.getByTestId("task-list-widget")).toBeInTheDocument();
    expect(screen.getByText("Open tasks")).toBeInTheDocument();
    expect(screen.getByText("2 open · 1 overdue")).toBeInTheDocument();
    expect(screen.getByTestId("task-list-item-t1")).toBeInTheDocument();
    expect(screen.getByTestId("task-list-item-t2")).toBeInTheDocument();
  });

  test("overdue task shows 'overdue' label; future shows 'due in Xh/d'", () => {
    render(<TaskListWidget spec={spec} />);
    /* Subtitle + row label both contain 'overdue' — assert at least one row says so. */
    expect(screen.getAllByText(/overdue/i).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/due in/)).toBeInTheDocument();
  });

  test("fires widget_rendered analytics on mount", () => {
    render(<TaskListWidget spec={spec} />);
    expect(mockFetch).toHaveBeenCalledWith(
      "/api/analytics",
      expect.objectContaining({
        body: expect.stringContaining("assistant.widget_rendered"),
      }),
    );
  });

  test("clicking the complete checkbox POSTs to /api/tasks/[id]/complete + tracks", async () => {
    render(<TaskListWidget spec={spec} />);
    mockFetch.mockClear();
    /* Two calls: complete + analytics. Both resolve to ok. */
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-list-complete-t1"));
    });
    await waitFor(() => {
      expect(mockFetch).toHaveBeenCalledWith(
        "/api/tasks/t1/complete",
        expect.objectContaining({ method: "POST" }),
      );
    });
    /* Analytics complete_task event fires after the POST resolves. */
    await waitFor(() => {
      const calls = mockFetch.mock.calls.filter((c) => c[0] === "/api/analytics");
      const bodies = calls.map((c) => c[1]?.body || "");
      expect(bodies.some((b: string) => b.includes("complete_task"))).toBe(true);
    });
  });

  test("after completion the row is visually crossed out (line-through)", async () => {
    render(<TaskListWidget spec={spec} />);
    mockFetch.mockResolvedValue({ ok: true, status: 200, json: async () => ({}) });
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-list-complete-t1"));
    });
    await waitFor(() => {
      const titleLink = screen.getByText("File Q3 expenses");
      expect(titleLink.className).toContain("line-through");
    });
  });

  test("complete-failure tracks complete_task_failed", async () => {
    render(<TaskListWidget spec={spec} />);
    mockFetch.mockClear();
    mockFetch.mockImplementation((url: string) => {
      if (url.includes("/complete")) {
        return Promise.resolve({ ok: false, status: 500, json: async () => ({}) });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("task-list-complete-t1"));
    });
    await waitFor(() => {
      const calls = mockFetch.mock.calls.filter((c) => c[0] === "/api/analytics");
      const bodies = calls.map((c) => c[1]?.body || "");
      expect(bodies.some((b: string) => b.includes("complete_task_failed"))).toBe(true);
    });
  });

  test("empty state when no tasks", () => {
    render(<TaskListWidget spec={{ ...spec, tasks: [] }} />);
    expect(screen.getByTestId("task-list-empty")).toBeInTheDocument();
  });
});

/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * Tasks page — the Outlook-parity New Task modal.
 *
 * Proves the primary surface now exposes the previously-missing controls
 * (reminder + the assignee picker), and that choosing an assignee routes the
 * create to Planner (POST /api/planner/tasks) — the only Graph surface that
 * supports assignments — with a plan required, rather than to personal To Do.
 */

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: any[]) => mockFetch(...args),
  authHeaders: () => ({ authorization: "Bearer test" }),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, fireEvent, waitFor, within } from "@testing-library/react";
import TasksPage from "@/app/(dashboard)/tasks/page";

const ALICE = {
  msUserId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
  displayName: "Alice Ops",
  userPrincipalName: "alice@wpa.test",
  mail: "alice@wpa.test",
  jobTitle: "Coordinator",
};

function json(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as unknown as Response;
}

function routeFetch(url: string, init?: { method?: string; body?: string }): Promise<Response> {
  const method = init?.method ?? "GET";
  if (url.startsWith("/api/integrations/status")) return Promise.resolve(json({ microsoft: { connected: true } }));
  if (url.startsWith("/api/tasks/lists")) return Promise.resolve(json({ lists: [] }));
  if (url.startsWith("/api/tasks") && method === "GET") return Promise.resolve(json({ tasks: [] }));
  if (url.startsWith("/api/planner/plans")) {
    return Promise.resolve(json({ plans: [{ id: "plan-1", msPlanId: "p1", title: "Team Plan" }] }));
  }
  if (url.startsWith("/api/directory/users")) return Promise.resolve(json({ users: [ALICE] }));
  if (url === "/api/planner/tasks") return Promise.resolve(json({ id: "t1", task: {} }, true, 201));
  if (url === "/api/analytics") return Promise.resolve(json({}));
  return Promise.resolve(json({}));
}

beforeEach(() => {
  mockFetch.mockReset();
  mockFetch.mockImplementation((url: string, init?: any) => routeFetch(url, init));
});

describe("TasksPage — New Task modal", () => {
  async function openModal() {
    render(<TasksPage />);
    const newBtn = await screen.findByText("+ New task");
    fireEvent.click(newBtn);
    return screen.getByRole("dialog", { name: "New task" });
  }

  it("exposes the reminder field and the assignee picker (previously missing)", async () => {
    const dialog = await openModal();
    expect(within(dialog).getByLabelText("Reminder")).toBeInTheDocument();
    expect(within(dialog).getByTestId("assignee-picker")).toBeInTheDocument();
  });

  it("assigning to a teammate requires a plan and creates a Planner task", async () => {
    const dialog = await openModal();

    fireEvent.change(within(dialog).getByLabelText("Task title"), { target: { value: "Follow up" } });

    // Select a teammate — the assignment path activates.
    const option = await within(dialog).findByTestId("assignee-option");
    fireEvent.click(option);

    // The plan block appears; wait for the plan option to load before picking
    // it (the plans fetch is async — selecting before it resolves is a no-op).
    const planSelect = await within(dialog).findByTestId("assign-plan-select");
    await within(dialog).findByRole("option", { name: "Team Plan" });
    fireEvent.change(planSelect, { target: { value: "plan-1" } });

    fireEvent.click(within(dialog).getByTestId("new-task-create"));

    await waitFor(() => {
      const call = mockFetch.mock.calls.find((c) => c[0] === "/api/planner/tasks");
      expect(call).toBeTruthy();
      const body = JSON.parse(call![1].body);
      expect(body.planId).toBe("plan-1");
      expect(body.assignees).toEqual([ALICE.msUserId]);
      expect(body.title).toBe("Follow up");
    });

    // And NOT to the personal To Do create endpoint.
    const todoCreate = mockFetch.mock.calls.find(
      (c) => c[0] === "/api/tasks" && (c[1]?.method ?? "GET") === "POST",
    );
    expect(todoCreate).toBeFalsy();
  });
});

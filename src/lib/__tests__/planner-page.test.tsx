/**
 * @jest-environment jsdom
 */

/**
 * /planner page — renders kanban, group + plan pickers, new task modal,
 * sync button triggers refetch, empty state when no groups.
 */

import "@testing-library/jest-dom";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

jest.mock("next/navigation", () => ({ useRouter: () => ({ push: jest.fn() }) }));

import PlannerPage from "@/app/(dashboard)/planner/page";

const fetchMock = jest.fn();

beforeAll(() => {
  (global as unknown as { fetch: jest.Mock }).fetch = fetchMock;
  Object.defineProperty(window, "localStorage", {
    value: {
      _store: { instinct_token: "tok" } as Record<string, string>,
      getItem(this: { _store: Record<string, string> }, k: string) { return this._store[k] ?? null; },
      setItem(this: { _store: Record<string, string> }, k: string, v: string) { this._store[k] = v; },
      removeItem(this: { _store: Record<string, string> }, k: string) { delete this._store[k]; },
    },
    writable: true,
  });
});

beforeEach(() => {
  fetchMock.mockReset();
});

function jsonRes(data: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(data),
  } as unknown as Response;
}

describe("Planner page", () => {
  it("shows connect CTA when Microsoft is not connected", async () => {
    fetchMock.mockImplementation((u: string) => {
      if (u.includes("/api/integrations/status")) {
        return Promise.resolve(jsonRes({ microsoft: { connected: false } }));
      }
      if (u.includes("/api/groups")) return Promise.resolve(jsonRes({ groups: [] }));
      if (u.includes("/api/planner/plans")) return Promise.resolve(jsonRes({ plans: [] }));
      return Promise.resolve(jsonRes({}));
    });
    render(<PlannerPage />);
    expect(await screen.findByText(/Connect Microsoft 365/i)).toBeInTheDocument();
  });

  it("renders group picker, plan picker, and kanban columns", async () => {
    fetchMock.mockImplementation((u: string) => {
      if (u.includes("/api/integrations/status")) {
        return Promise.resolve(jsonRes({ microsoft: { connected: true } }));
      }
      if (u.includes("/api/groups")) {
        return Promise.resolve(jsonRes({
          groups: [{ id: "g1", msGroupId: "ms-g1", displayName: "Team A" }],
        }));
      }
      if (u.match(/\/api\/planner\/plans(\?|$)/)) {
        return Promise.resolve(jsonRes({
          plans: [{ id: "p1", msPlanId: "ms-p1", title: "Roadmap", groupId: "g1", msContainerType: "group" }],
        }));
      }
      if (u.includes("/buckets")) {
        return Promise.resolve(jsonRes({
          buckets: [{ id: "b1", msBucketId: "ms-b1", name: "To Do" }],
        }));
      }
      if (u.includes("/tasks")) {
        return Promise.resolve(jsonRes({ tasks: [], nextCursor: null }));
      }
      return Promise.resolve(jsonRes({}));
    });

    render(<PlannerPage />);
    await waitFor(() => expect(screen.getByText("Planner")).toBeInTheDocument());
    expect(await screen.findByText("Team A")).toBeInTheDocument();
    // Plan picker shows a placeholder until a plan is chosen.
    expect(screen.getByRole("combobox", { name: "Plan" })).toBeInTheDocument();
  });

  it("Sync now triggers groups + planner sync POSTs + refetches", async () => {
    const calls: string[] = [];
    fetchMock.mockImplementation((u: string, opts?: RequestInit) => {
      calls.push(`${opts?.method ?? "GET"} ${u}`);
      if (u.includes("/api/integrations/status")) {
        return Promise.resolve(jsonRes({ microsoft: { connected: true } }));
      }
      if (u.includes("/api/groups/sync")) return Promise.resolve(jsonRes({ count: 1 }));
      if (u.includes("/api/planner/sync")) {
        return Promise.resolve(jsonRes({ planCount: 1, bucketCount: 1, taskCount: 1, durationMs: 1 }));
      }
      if (u.includes("/api/groups")) return Promise.resolve(jsonRes({ groups: [] }));
      if (u.match(/\/api\/planner\/plans(\?|$)/)) return Promise.resolve(jsonRes({ plans: [] }));
      return Promise.resolve(jsonRes({}));
    });

    render(<PlannerPage />);
    const btn = await screen.findByRole("button", { name: /sync now/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(calls.some((c) => c === "POST /api/groups/sync")).toBe(true);
      expect(calls.some((c) => c === "POST /api/planner/sync")).toBe(true);
    });
  });

  it("shows empty state when no groups are synced yet", async () => {
    fetchMock.mockImplementation((u: string) => {
      if (u.includes("/api/integrations/status")) {
        return Promise.resolve(jsonRes({ microsoft: { connected: true } }));
      }
      if (u.includes("/api/groups")) return Promise.resolve(jsonRes({ groups: [] }));
      if (u.match(/\/api\/planner\/plans(\?|$)/)) return Promise.resolve(jsonRes({ plans: [] }));
      return Promise.resolve(jsonRes({}));
    });
    render(<PlannerPage />);
    expect(await screen.findByText(/No groups synced yet/i)).toBeInTheDocument();
  });

  it("renders a task card + opens drawer when clicked", async () => {
    fetchMock.mockImplementation((u: string) => {
      if (u.includes("/api/integrations/status")) {
        return Promise.resolve(jsonRes({ microsoft: { connected: true } }));
      }
      if (u.includes("/api/groups")) {
        return Promise.resolve(jsonRes({ groups: [{ id: "g1", msGroupId: "mg", displayName: "Team" }] }));
      }
      if (u.match(/\/api\/planner\/plans(\?|$)/)) {
        return Promise.resolve(jsonRes({
          plans: [{ id: "p1", msPlanId: "mp", title: "Plan 1", groupId: "g1", msContainerType: "group" }],
        }));
      }
      if (u.includes("/buckets")) {
        return Promise.resolve(jsonRes({
          buckets: [{ id: "b1", msBucketId: "mb", name: "To Do" }],
        }));
      }
      if (u.includes("/tasks")) {
        return Promise.resolve(jsonRes({
          tasks: [{
            id: "t1", msTaskId: "mt", planId: "p1", bucketId: "b1",
            title: "Demo task", dueAt: null, percentComplete: 25, priority: 5,
            assignees: ["user-1"], etag: "W/\"v1\"",
          }],
          nextCursor: null,
        }));
      }
      return Promise.resolve(jsonRes({}));
    });

    render(<PlannerPage />);
    // Select the plan so the board renders.
    const planPicker = await screen.findByRole("combobox", { name: "Plan" });
    fireEvent.change(planPicker, { target: { value: "p1" } });
    expect(await screen.findByText("Demo task")).toBeInTheDocument();

    fireEvent.click(screen.getByText("Demo task"));
    expect(await screen.findByRole("dialog", { name: /planner task/i })).toBeInTheDocument();
  });
});

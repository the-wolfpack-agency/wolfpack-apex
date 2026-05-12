/** @jest-environment jsdom */
 
import "@testing-library/jest-dom";

/**
 * WeeklyReview component — mount fetch, analytics shape on view,
 * Resolve button PATCHes the task + fires review.slip_resolved,
 * error path renders a visible error.
 */

const mockFetch = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...args: any[]) => mockFetch(...args),
  jsonHeaders: () => ({ "Content-Type": "application/json" }),
}));

import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import WeeklyReview from "@/components/WeeklyReview";

function jsonResponse(data: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => data } as unknown as Response;
}

const baseData = {
  weekStart: "2026-04-20T00:00:00.000Z",
  weekEnd: "2026-04-27T00:00:00.000Z",
  meetingsAttended: 4,
  tasksClosed: 7,
  tasksOpened: 3,
  unansweredFlagged: 2,
  slips: [
    { id: "slip-1", title: "Overdue A", reason: "overdue", dueAt: "2026-04-18T12:00:00Z" },
  ],
};

beforeEach(() => {
  mockFetch.mockReset();
});

describe("WeeklyReview", () => {
  it("renders counts + slip list after load and fires review.weekly_viewed on mount", async () => {
    mockFetch.mockImplementation((url: string) => {
      if (typeof url === "string" && url.startsWith("/api/review/weekly")) {
        return Promise.resolve(jsonResponse(baseData));
      }
      // analytics POST
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<WeeklyReview />);

    await waitFor(() => expect(screen.getByTestId("weekly-review")).toBeInTheDocument());
    expect(screen.getByTestId("weekly-review-meetings")).toHaveTextContent("4");
    expect(screen.getByTestId("weekly-review-closed")).toHaveTextContent("7");
    expect(screen.getByTestId("weekly-review-opened")).toHaveTextContent("3");
    expect(screen.getByTestId("weekly-review-unanswered")).toHaveTextContent("2");
    expect(screen.getByTestId("weekly-review-slip-slip-1")).toBeInTheDocument();

    // Analytics POST for review.weekly_viewed
    await waitFor(() => {
      const analyticsCall = mockFetch.mock.calls.find(
        (c) => typeof c[0] === "string" && c[0] === "/api/analytics",
      );
      expect(analyticsCall).toBeTruthy();
    });

    const analyticsCall = mockFetch.mock.calls.find(
      (c) => typeof c[0] === "string" && c[0] === "/api/analytics",
    )!;
    const body = JSON.parse((analyticsCall[1] as RequestInit).body as string);
    expect(body.event).toBe("review.weekly_viewed");
    expect(body.metadata.week_start).toBe("2026-04-20T00:00:00.000Z");
    expect(body.metadata.slip_count).toBe(1);
    expect(body.metadata.meetings_attended).toBe(4);
    expect(body.metadata.tasks_closed).toBe(7);
  });

  it("renders empty-state when there are no slips", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ ...baseData, slips: [] }));
    render(<WeeklyReview />);
    await waitFor(() => expect(screen.getByTestId("weekly-review")).toBeInTheDocument());
    expect(screen.getByTestId("weekly-review-slips-empty")).toHaveTextContent(
      /nothing slipped/i,
    );
  });

  it("clicking Resolve PATCHes the task with inProgress and fires review.slip_resolved", async () => {
    const calls: string[] = [];
    mockFetch.mockImplementation((url: RequestInfo | URL, init?: RequestInit) => {
      const u = String(url);
      calls.push(`${init?.method ?? "GET"} ${u}`);
      if (u.startsWith("/api/review/weekly")) {
        return Promise.resolve(jsonResponse(baseData));
      }
      if (u.startsWith("/api/tasks/")) {
        return Promise.resolve(jsonResponse({ ok: true }));
      }
      return Promise.resolve(jsonResponse({ ok: true }));
    });

    render(<WeeklyReview />);
    await waitFor(() => expect(screen.getByTestId("weekly-review-slip-slip-1")).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("weekly-review-resolve-slip-1"));

    await waitFor(() => {
      expect(calls.some((c) => c === "PATCH /api/tasks/slip-1")).toBe(true);
    });

    // The PATCH body must be inProgress.
    const patchCall = mockFetch.mock.calls.find(
      (c) => String(c[0]) === "/api/tasks/slip-1" && (c[1] as RequestInit | undefined)?.method === "PATCH",
    )!;
    const patchBody = JSON.parse((patchCall[1] as RequestInit).body as string);
    expect(patchBody.status).toBe("inProgress");

    // Analytics: review.slip_resolved fires after PATCH.
    await waitFor(() => {
      const resolvedCall = mockFetch.mock.calls
        .filter((c) => String(c[0]) === "/api/analytics")
        .map((c) => JSON.parse((c[1] as RequestInit).body as string))
        .find((b) => b.event === "review.slip_resolved");
      expect(resolvedCall).toBeTruthy();
      expect(resolvedCall.metadata.task_id).toBe("slip-1");
      expect(resolvedCall.metadata.reason).toBe("overdue");
      expect(resolvedCall.metadata.week_start).toBe("2026-04-20T00:00:00.000Z");
    });

    // Button flips to Resolved.
    await waitFor(() =>
      expect(screen.getByTestId("weekly-review-resolve-slip-1")).toHaveTextContent("Resolved"),
    );
  });

  it("renders a visible error when the fetch fails", async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: "boom" }, false, 500));
    render(<WeeklyReview />);
    await waitFor(() => expect(screen.getByTestId("weekly-review-error")).toBeInTheDocument());
    expect(screen.getByTestId("weekly-review-error")).toHaveTextContent(/failed to load/i);
  });

  it("renders a visible error when fetch throws", async () => {
    mockFetch.mockRejectedValue(new Error("net down"));
    render(<WeeklyReview />);
    await waitFor(() => expect(screen.getByTestId("weekly-review-error")).toBeInTheDocument());
  });
});

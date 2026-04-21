/** @jest-environment jsdom */
/* eslint-disable @typescript-eslint/no-explicit-any */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
  authHeaders: () => ({ Authorization: "Bearer x" }),
  jsonHeaders: () => ({ "Content-Type": "application/json", Authorization: "Bearer x" }),
}));

import { render, screen, waitFor } from "@testing-library/react";
import MsInsightsPanel from "@/components/MsInsightsPanel";

function mockInsights(insights: any[], status = 200) {
  mockFetchWithRefresh.mockImplementation((url: string) => {
    if (typeof url === "string" && url.startsWith("/api/ms/insights")) {
      return Promise.resolve({
        status,
        ok: status >= 200 && status < 300,
        json: async () => ({ insights }),
      });
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
  });
}

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("MsInsightsPanel", () => {
  test("renders insights + fires ms_insight.viewed once per insight", async () => {
    mockInsights([
      { id: "meeting_load", kind: "calendar", severity: "warn", headline: "Heavy day", detail: "4h", metric: 4 },
      { id: "overdue_tasks", kind: "tasks", severity: "risk", headline: "3 overdue", detail: "", metric: 3, cta: { label: "Open", href: "/tasks" } },
    ]);
    render(<MsInsightsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ms-insights-panel")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("insight-meeting_load")).toBeInTheDocument();
    expect(screen.getByTestId("insight-overdue_tasks")).toBeInTheDocument();

    const viewedCalls = mockFetchWithRefresh.mock.calls.filter(
      (c) => typeof c[0] === "string" && c[0] === "/api/analytics",
    );
    const events = viewedCalls.map((c) => JSON.parse(c[1].body).event);
    expect(events.filter((e) => e === "ms_insight.viewed")).toHaveLength(2);
  });

  test("renders error state on non-ok", async () => {
    mockInsights([], 500);
    render(<MsInsightsPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("ms-insights-panel-error")).toBeInTheDocument(),
    );
  });

  test("hides entirely on 403 (restricted)", async () => {
    mockInsights([], 403);
    const { container } = render(<MsInsightsPanel />);
    await waitFor(() => {
      expect(screen.queryByTestId("ms-insights-panel-loading")).toBeNull();
    });
    expect(container.innerHTML).toBe("");
  });
});

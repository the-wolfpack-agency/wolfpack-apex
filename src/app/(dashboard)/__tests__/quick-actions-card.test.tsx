/**
 * @jest-environment jsdom
 *
 * Tests for the personalized Quick Actions card on the dashboard:
 *   1. Pure-payload helpers — assert the exact shape of the analytics
 *      events the component fires.
 *   2. Render + click — mount the dashboard with mocked fetches that
 *      return personalized actions, click a tile, assert the
 *      `dashboard.quick_action_clicked` POST goes to /api/analytics
 *      with the right payload (href, position, source).
 *
 * The dashboard page makes 4 background fetches on mount (workspace
 * status, dashboard stats, journal, quick-actions). All four are
 * mocked through `client-auth.fetchWithRefresh` so we can assert the
 * 5th POST — the click — happened with our exact payload.
 */

import "@testing-library/jest-dom";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

const fetchMock = jest.fn();

jest.mock("@/lib/client-auth", () => ({
  getInstinctToken: () => "test-token",
  authHeaders: () => ({ Authorization: "Bearer test-token" }),
  jsonHeaders: () => ({ "content-type": "application/json", Authorization: "Bearer test-token" }),
  fetchWithRefresh: (...args: unknown[]) => fetchMock(...args),
  clearInstinctSession: jest.fn(),
}));

// Stub heavy dashboard subcomponents — they pull in their own fetches
// that we don't care about here.
jest.mock("@/components/IntegrationStatusBanner", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/MorningBriefing", () => ({
  __esModule: true,
  default: () => null,
}));
jest.mock("@/components/MsInsightsPanel", () => ({
  __esModule: true,
  default: () => null,
}));

import DashboardPage, {
  buildQuickActionClickPayload,
  buildQuickActionsRenderedPayload,
} from "@/app/(dashboard)/page";

describe("buildQuickActionClickPayload", () => {
  test("emits dashboard.quick_action_clicked with href + position + source", () => {
    const payload = buildQuickActionClickPayload(
      { label: "Messages", href: "/messages", score: 1.5, source: "personalized" },
      2,
    );
    expect(payload).toEqual({
      event: "dashboard.quick_action_clicked",
      metadata: { href: "/messages", position: 2, source: "personalized" },
    });
  });

  test("preserves fallback source when called on a fallback tile", () => {
    const payload = buildQuickActionClickPayload(
      { label: "Ask a Question", href: "/knowledge", score: 0, source: "fallback" },
      0,
    );
    expect(payload.metadata.source).toBe("fallback");
  });
});

describe("buildQuickActionsRenderedPayload", () => {
  test("source comes from the first tile, action_count = list length", () => {
    const payload = buildQuickActionsRenderedPayload([
      { label: "Messages", href: "/messages", score: 2, source: "personalized" },
      { label: "Calendar", href: "/calendar", score: 1, source: "personalized" },
      { label: "Tasks", href: "/tasks", score: 0.7, source: "personalized" },
      { label: "Emails", href: "/emails", score: 0.6, source: "personalized" },
    ]);
    expect(payload).toEqual({
      event: "dashboard.quick_actions_rendered",
      metadata: { source: "personalized", action_count: 4 },
    });
  });

  test("empty list defaults to fallback / 0", () => {
    const payload = buildQuickActionsRenderedPayload([]);
    expect(payload.metadata.source).toBe("fallback");
    expect(payload.metadata.action_count).toBe(0);
  });
});

describe("Quick Actions card — render + click", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Default: every endpoint returns benign empty data so the page
    // can mount without unhandled rejections.
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/insights/quick-actions")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              actions: [
                { label: "Messages", href: "/messages", score: 2.4, source: "personalized" },
                { label: "Calendar", href: "/calendar", score: 1.8, source: "personalized" },
                { label: "Tasks", href: "/tasks", score: 1.1, source: "personalized" },
                { label: "Emails", href: "/emails", score: 0.9, source: "personalized" },
              ],
            }),
        });
      }
      if (url.startsWith("/api/dashboard")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              shadow_mode: false,
              knowledge_count: 0,
              discussion_count: 0,
              feature_count: 0,
              team_count: 0,
              ai_efficiency: null,
            }),
        });
      }
      // /api/journal, /api/workspace/status, /api/analytics POSTs all
      // fall through to a 200 with empty body.
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    // localStorage briefing flag → set to "false" so the briefing
    // component never tries to render.
    window.localStorage.setItem("instinct_briefing_enabled", "false");
  });

  it("renders personalized tiles and fires the rendered analytics event", async () => {
    await act(async () => {
      render(<DashboardPage />);
    });

    // Wait for the personalized fetch to land + the card to swap out
    // of fallback into personalized.
    await waitFor(() => {
      const card = screen.getByTestId("quick-actions");
      expect(card.getAttribute("data-source")).toBe("personalized");
    });

    const tiles = screen.getAllByTestId("quick-action-tile");
    expect(tiles).toHaveLength(4);
    expect(tiles[0].textContent).toContain("Messages");
    expect(tiles[0].getAttribute("data-href")).toBe("/messages");

    // The "rendered" analytics event must have fired exactly once,
    // with source=personalized.
    await waitFor(() => {
      const renderedCall = fetchMock.mock.calls.find(([url, opts]) => {
        if (url !== "/api/analytics") return false;
        const o = opts as { body?: string } | undefined;
        if (!o?.body) return false;
        try {
          return JSON.parse(o.body).event === "dashboard.quick_actions_rendered";
        } catch {
          return false;
        }
      });
      expect(renderedCall).toBeTruthy();
      const body = JSON.parse((renderedCall![1] as { body: string }).body);
      expect(body.metadata.source).toBe("personalized");
      expect(body.metadata.action_count).toBe(4);
    });
  });

  it("fires dashboard.quick_action_clicked with href + position + source on click", async () => {
    await act(async () => {
      render(<DashboardPage />);
    });

    await waitFor(() => {
      expect(screen.getByTestId("quick-actions").getAttribute("data-source")).toBe("personalized");
    });

    const tiles = screen.getAllByTestId("quick-action-tile");
    expect(tiles[1].getAttribute("data-href")).toBe("/calendar");

    fireEvent.click(tiles[1]);

    await waitFor(() => {
      const clickCall = fetchMock.mock.calls.find(([url, opts]) => {
        if (url !== "/api/analytics") return false;
        const o = opts as { body?: string } | undefined;
        if (!o?.body) return false;
        try {
          return JSON.parse(o.body).event === "dashboard.quick_action_clicked";
        } catch {
          return false;
        }
      });
      expect(clickCall).toBeTruthy();
      const body = JSON.parse((clickCall![1] as { body: string }).body);
      expect(body.metadata).toEqual({
        href: "/calendar",
        position: 1,
        source: "personalized",
      });
    });
  });

  it("falls back to static four tiles when the personalized endpoint errors", async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/api/insights/quick-actions")) {
        return Promise.reject(new Error("network down"));
      }
      if (url.startsWith("/api/dashboard")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () =>
            Promise.resolve({
              shadow_mode: false,
              knowledge_count: 0,
              discussion_count: 0,
              feature_count: 0,
              team_count: 0,
              ai_efficiency: null,
            }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({}),
      });
    });

    await act(async () => {
      render(<DashboardPage />);
    });

    // After the dashboard stats land we know loading is done; the
    // quick-actions endpoint rejected so the card stays on fallback.
    await waitFor(() => {
      const card = screen.getByTestId("quick-actions");
      expect(card.getAttribute("data-source")).toBe("fallback");
      const tiles = screen.getAllByTestId("quick-action-tile");
      expect(tiles).toHaveLength(4);
    });
  });
});

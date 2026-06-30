/** @jest-environment jsdom */

import "@testing-library/jest-dom";

/**
 * UI tests for the governance drift-trends section on /admin/ogiam.
 *
 * Asserts: the trends grid + sparklines render from a mocked /trends fetch, the
 * empty state shows when every series is empty, and the error state shows on a
 * 403. The page fires three fetches on mount (decisions + verify + trends);
 * responses are routed by URL so the effects can race without flaking. The
 * decisions + verify legs are stubbed to a benign shape so this file focuses on
 * the trends section.
 */

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: unknown[]) =>
    (mockFetchWithRefresh as unknown as (...args: unknown[]) => unknown)(...a),
}));

import { act, render, screen, waitFor } from "@testing-library/react";
import OgiamPage from "@/app/(dashboard)/admin/ogiam/page";

function mkRes(body: unknown, opts: { ok?: boolean; status?: number } = {}): any {
  return { ok: opts.ok ?? true, status: opts.status ?? 200, json: async () => body };
}

const benignDecisions = {
  workspace_id: "default",
  summary: { total: 0, would_block: 0, by_tier: {}, by_outcome: {} },
  decisions: [],
};

/** Route the three mount fetches; `trends` is the body the /trends leg returns
 *  (or {ok,status} to force a non-ok). */
function routeFetch(trends: unknown, trendsOpts?: { ok?: boolean; status?: number }) {
  mockFetchWithRefresh.mockImplementation((url: unknown) => {
    const u = String(url);
    if (u.includes("/api/admin/ogiam/verify")) {
      return Promise.resolve(mkRes({}, { ok: false, status: 500 }));
    }
    if (u.includes("/api/admin/ogiam/trends")) {
      return Promise.resolve(mkRes(trends, trendsOpts));
    }
    return Promise.resolve(mkRes(benignDecisions));
  });
}

const populatedTrends = {
  workspace_id: "default",
  window_days: 30,
  decisions: [
    { day: "2026-06-27", total: 5, would_block: 2 },
    { day: "2026-06-28", total: 8, would_block: 1 },
  ],
  redteam: [
    { day: "2026-06-27", pass_rate: 1, vulns: 0, runs: 1 },
    { day: "2026-06-28", pass_rate: 0.9, vulns: 1, runs: 1 },
  ],
  surfaces: [
    { day: "2026-06-27", new_ungoverned: 2, cumulative_ungoverned: 2 },
    { day: "2026-06-28", new_ungoverned: 1, cumulative_ungoverned: 3 },
  ],
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

describe("/admin/ogiam: governance trends section", () => {
  it("renders the trends grid + sparklines from the fetch", async () => {
    routeFetch(populatedTrends);

    await act(async () => {
      render(<OgiamPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("ogiam-trends-grid")).toBeInTheDocument(),
    );
    // The four trend tiles each render a sparkline.
    expect(screen.getByTestId("ogiam-trend-tile-decisions")).toBeInTheDocument();
    expect(screen.getByTestId("ogiam-trend-tile-passrate")).toBeInTheDocument();
    expect(screen.getByTestId("ogiam-trend-tile-ungoverned")).toBeInTheDocument();
    expect(screen.getByTestId("ogiam-trend-spark-decisions")).toBeInTheDocument();
    // Pass rate headline reflects the latest day (0.9 → 90%).
    expect(screen.getByTestId("ogiam-trend-tile-passrate")).toHaveTextContent("90%");
    // Ungoverned cumulative reflects the latest day (3).
    expect(screen.getByTestId("ogiam-trend-tile-ungoverned")).toHaveTextContent("3");
  });

  it("renders the empty state when every series is empty", async () => {
    routeFetch({ workspace_id: "default", window_days: 30, decisions: [], redteam: [], surfaces: [] });

    await act(async () => {
      render(<OgiamPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("ogiam-trends-empty")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("ogiam-trends-grid")).not.toBeInTheDocument();
  });

  it("renders the error state on a 403", async () => {
    routeFetch({}, { ok: false, status: 403 });

    await act(async () => {
      render(<OgiamPage />);
    });

    await waitFor(() =>
      expect(screen.getByTestId("ogiam-trends-error")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("ogiam-trends-error")).toHaveTextContent(/permission/i);
  });
});

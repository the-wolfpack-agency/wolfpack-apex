/** @jest-environment jsdom */
import "@testing-library/jest-dom";

const mockFetchWithRefresh = jest.fn();
jest.mock("@/lib/client-auth", () => ({
  fetchWithRefresh: (...a: any[]) => mockFetchWithRefresh(...a),
}));

import { render, screen, waitFor } from "@testing-library/react";
import SiteAnalyticsPage from "@/app/(dashboard)/admin/site-analytics/page";

const SUMMARY = {
  rangeDays: 30,
  totalPageViews: 128,
  totalEvents: 190,
  byHour: [
    { hour: 9, count: 12 },
    { hour: 14, count: 30 },
  ],
  byPage: [{ path: "/ogiam-iam", count: 80 }, { path: "/agentic-qa", count: 48 }],
  byCountry: [{ country: "US", count: 90 }],
  byType: [{ type: "site.page_viewed", count: 128 }],
};

beforeEach(() => {
  mockFetchWithRefresh.mockReset();
});

test("renders the reused heatmap, totals, and top pages/countries from the summary", async () => {
  mockFetchWithRefresh.mockResolvedValue({
    ok: true,
    json: async () => ({ summary: SUMMARY }),
  });

  render(<SiteAnalyticsPage />);

  await waitFor(() => expect(screen.getByTestId("site-hour-heatmap")).toBeInTheDocument());
  // 24 cells in the reused HourHeatmap.
  expect(screen.getAllByTestId("site-hour-cell")).toHaveLength(24);
  expect(screen.getByTestId("total-page-views")).toHaveTextContent("128");
  expect(screen.getByTestId("top-pages")).toHaveTextContent("/ogiam-iam");
  expect(screen.getByTestId("top-countries")).toHaveTextContent("US");

  // The data route was queried with the default 30-day window.
  expect(String(mockFetchWithRefresh.mock.calls[0][0])).toContain("days=30");
});

test("shows an error state when the data route fails", async () => {
  mockFetchWithRefresh.mockResolvedValue({ ok: false, json: async () => ({}) });
  render(<SiteAnalyticsPage />);
  await waitFor(() => expect(screen.getByTestId("site-analytics-error")).toBeInTheDocument());
});
